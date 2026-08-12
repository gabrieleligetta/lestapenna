import * as cron from 'node-cron';
import * as fs from 'fs';
import * as path from 'path';
import { ListObjectsV2Command, ListObjectsV2CommandOutput, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { deleteRawSessionFiles, deleteStaleTranscriptionTempFiles, getS3Client, getBucketName, checkStorageUsage } from './backup';
import { mixSessionAudio } from './sessionMixer';
import { db } from '../db';
import { logger } from '../utils/logger';

const log = logger('Janitor');

// Configurazione
const JANITOR_SCHEDULE = '0 4 * * *'; // Every day at 04:00
const RETENTION_HOURS = 48; // Hours to keep files after the Master is created
// No default: a name written here is the maintainer's bucket, and a self-hoster's
// janitor would try to write its own backups over it. Empty means «DB backup not
// configured», and the job simply skips.
const DB_BACKUP_BUCKET = process.env.OCI_DB_BACKUP_BUCKET || '';
const DB_BACKUP_RETENTION_DAYS = 7;
const DEBUG_PROMPTS_RETENTION_DAYS = 14; // transcripts/<sessione>/debug_prompts/
/**
 * How long the raw per-speaker audio survives.
 *
 * It used to survive until the bucket passed 8 GB, and only then — which meant a
 * small instance kept everyone's voice recordings forever, while the privacy
 * policy told people the audio was «deleted once the session archive exists».
 * Discord's Developer Terms §5(b) require deletion once retention «is no longer
 * necessary for your Application's stated functionality»: the recap is the
 * functionality, and once the mixed master exists the raw stems are no longer
 * needed for it.
 *
 * Zero disables the age-based pass and leaves only the storage-pressure one —
 * for a self-hoster who deliberately wants to keep their own stems.
 */
const RAW_AUDIO_RETENTION_DAYS = Number(process.env.RAW_AUDIO_RETENTION_DAYS ?? '30');

import { Client, TextChannel } from 'discord.js';
import { getGuildConfig } from '../db';
import { config } from '../config';

let _discordClient: Client | null = null;

export function startJanitor(client?: Client) {
    if (client) _discordClient = client;
    log.info(`Servizio di pulizia programmato: ${JANITOR_SCHEDULE}`);

    // Run immediately at startup (in the background, it does not block the boot)
    setTimeout(() => {
        runJanitorCycle().catch(err => log.error('Errore ciclo startup', err as Error));
        runDbBackup().catch(err => log.error('Errore backup DB startup', err as Error));
    }, 30_000); // 30s of delay to let the boot finish

    cron.schedule(JANITOR_SCHEDULE, async () => {
        log.info('Inizio ciclo di pulizia giornaliero...');
        await runJanitorCycle();
        await runDbBackup();
        log.info('Ciclo terminato. Prossima esecuzione domani.');
    });
}

/**
 * Send a backup alert to the developer via Discord DM.
 */
async function sendBackupAlert(message: string, isError: boolean) {
    if (!_discordClient) return;
    // With no developer configured there is nobody to send it to: that is the
    // normal case for anyone self-hosting, not an error to log on every round.
    if (!config.discord.developerId) return;
    try {
        const devUser = await _discordClient.users.fetch(config.discord.developerId);
        const prefix = isError ? '🚨 **BACKUP ALERT**' : '✅ **Backup OK**';
        await devUser.send(`${prefix}\n${message}`);
    } catch (err) {
        log.warn('Impossibile inviare alert backup via Discord');
    }
}

/**
 * 🆕 Cleanup of the LOCAL artifacts (they used to grow without limit):
 * - mixed_sessions/: master MP3s already uploaded to Oracle (retention RETENTION_HOURS)
 * - temp_mix/: orphan stems left by a crash halfway through a mix (same retention)
 * - transcripts/<id>/debug_prompts/: dumps of AI prompts/responses (retention 14 days)
 */
function cleanupLocalArtifacts() {
    const now = Date.now();

    const deleteOldFiles = (dir: string, maxAgeMs: number, label: string) => {
        if (!fs.existsSync(dir)) return;
        let deleted = 0;
        try {
            for (const file of fs.readdirSync(dir)) {
                if (file.startsWith('.')) continue;
                const filePath = path.join(dir, file);
                try {
                    const stats = fs.statSync(filePath);
                    if (!stats.isFile() || now - stats.mtimeMs < maxAgeMs) continue;
                    fs.unlinkSync(filePath);
                    deleted++;
                } catch { /* file vanished in the meantime: fine */ }
            }
        } catch (e) {
            console.warn(`[Janitor] ⚠️ Pulizia ${label} fallita:`, e);
        }
        if (deleted > 0) console.log(`[Janitor] 🧹 Rimossi ${deleted} file da ${label}.`);
    };

    deleteOldFiles(config.paths.mixedSessionsDir, RETENTION_HOURS * 3600_000, 'mixed_sessions');
    deleteOldFiles(config.paths.tempMixDir, RETENTION_HOURS * 3600_000, 'temp_mix');

    // debug_prompts: nested directories transcripts/<session>/debug_prompts/
    const transcriptsDir = config.paths.transcriptsDir;
    if (fs.existsSync(transcriptsDir)) {
        const maxAgeMs = DEBUG_PROMPTS_RETENTION_DAYS * 24 * 3600_000;
        try {
            for (const session of fs.readdirSync(transcriptsDir)) {
                const debugDir = path.join(transcriptsDir, session, 'debug_prompts');
                deleteOldFiles(debugDir, maxAgeMs, `debug_prompts/${session}`);
                // Remove the dir when emptied (rmdir fails when not empty: fine)
                try { fs.rmdirSync(debugDir); } catch { }
            }
        } catch (e) {
            console.warn('[Janitor] ⚠️ Pulizia debug_prompts fallita:', e);
        }
    }
}

interface IndexedSession {
    id: string;
    /** The oldest FLAC of the session: when the recording actually happened. */
    date: Date;
    hasMaster: boolean;
    hasFlac: boolean;
}

/**
 * Indexes the sessions that have raw audio in the bucket, oldest first.
 *
 * The key layout is not uniform and never was: raw stems are written under
 * `recordings/{guildId}/{sessionId}/{file}` when the guild can be resolved and
 * under `recordings/{sessionId}/{file}` when it cannot, while the mixed master
 * always lands on the flat `recordings/{sessionId}/` path.
 *
 * This used to read `parts[1]` as the session id regardless, which on the
 * tenant layout is the **guild** id — so every guild appeared as a single
 * enormous «session» whose master status was whatever the first match happened
 * to be. Getting it wrong in the direction of deletion is the dangerous
 * direction, so the segment count decides which layout a key belongs to.
 */
async function indexSessions(): Promise<IndexedSession[]> {
    const client = getS3Client();
    const bucket = getBucketName();
    const sessionMap = new Map<string, { date: Date; hasMaster: boolean; hasFlac: boolean }>();
    let continuationToken: string | undefined = undefined;

    do {
        const listCmd: ListObjectsV2Command = new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: 'recordings/',
            ContinuationToken: continuationToken,
        });
        const response: ListObjectsV2CommandOutput = await client.send(listCmd);

        for (const obj of response.Contents || []) {
            if (!obj.Key) continue;
            const parts = obj.Key.split('/');
            // recordings/{sessionId}/{file}            → 3 segments
            // recordings/{guildId}/{sessionId}/{file}  → 4 segments
            const sessionId = parts.length >= 4 ? parts[2] : parts.length === 3 ? parts[1] : null;
            if (!sessionId) continue;

            if (!sessionMap.has(sessionId)) {
                sessionMap.set(sessionId, { date: obj.LastModified || new Date(), hasMaster: false, hasFlac: false });
            }
            const entry = sessionMap.get(sessionId)!;

            if (obj.Key.endsWith('_master.mp3')) {
                entry.hasMaster = true;
            } else if (obj.Key.endsWith('.flac')) {
                entry.hasFlac = true;
                if (obj.LastModified && obj.LastModified < entry.date) entry.date = obj.LastModified;
            }
        }
        continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return Array.from(sessionMap.entries())
        .filter(([, data]) => data.hasFlac)
        .map(([id, data]) => ({ id, ...data }))
        .sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * Deletes raw stems older than {@link RAW_AUDIO_RETENTION_DAYS}.
 *
 * A session without its mixed master is mixed first: the recap is the reason the
 * audio was collected, and deleting the stems before producing it would destroy
 * the thing the table consented to. If the mix fails, the stems stay — a failed
 * retention pass is recoverable, an unrecoverable deletion is not.
 */
async function pruneExpiredRawAudio(sessions: IndexedSession[]): Promise<void> {
    if (RAW_AUDIO_RETENTION_DAYS <= 0) return;

    const cutoff = Date.now() - RAW_AUDIO_RETENTION_DAYS * 24 * 3600_000;
    const expired = sessions.filter(s => s.date.getTime() < cutoff);
    if (expired.length === 0) return;

    console.log(`[Janitor] ⏳ ${expired.length} sessioni oltre i ${RAW_AUDIO_RETENTION_DAYS} giorni di conservazione dell'audio grezzo.`);

    for (const session of expired) {
        if (!session.hasMaster) {
            try {
                await mixSessionAudio(session.id, false);
            } catch (mixErr: any) {
                console.warn(`[Janitor] ⚠️ Mix fallito per ${session.id}: ${mixErr.message}. Conservo i FLAC.`);
                continue;
            }
        }
        const deleted = await deleteRawSessionFiles(session.id);
        if (deleted > 0) {
            console.log(`[Janitor] 🗑️ Sessione ${session.id}: rimossi ${deleted} FLAC scaduti.`);
        }
    }
}

async function runJanitorCycle() {
    console.log(`[Janitor] 🧹 Inizio ciclo di pulizia intelligente...`);

    // Local cleanup: always, regardless of the state of the remote storage.
    cleanupLocalArtifacts();

    try {
        // 0. Cleanup of the orphan files in transcription_temp/ (temporary uploads for the
        // remote PC, normally deleted by scriba.ts right after use; a process crash
        // before the cleanup leaves them there forever). It always runs,
        // regardless of the space threshold, because they are pure garbage.
        const staleTempDeleted = await deleteStaleTranscriptionTempFiles(RETENTION_HOURS);
        if (staleTempDeleted > 0) {
            console.log(`[Janitor] 🧹 Rimossi ${staleTempDeleted} upload orfani da transcription_temp/.`);
        }

        // 1. Check Space Usage First
        const stats = await checkStorageUsage(true); // silent check
        if (!stats.ok) {
            console.error(`[Janitor] ❌ Controllo storage fallito — salto il ciclo di pulizia per evitare di scambiare un errore per "storage vuoto".`);
            return;
        }
        console.log(`[Janitor] 📊 Storage attuale: ${stats.totalGB.toFixed(2)} GB / ${stats.freeTierLimitGB} GB (${stats.percentUsed.toFixed(1)}%)`);

        // THRESHOLDS
        const TRIGGER_THRESHOLD_GB = 8.0; // Start cleaning if > 8GB
        const TARGET_THRESHOLD_GB = 7.0;  // Stop cleaning when < 7GB

        // 2. Index ALL the sessions with FLAC files, tracking whether they have the master
        console.log(`[Janitor] 🔍 Indicizzazione sessioni nel bucket...`);
        const sessions = await indexSessions();

        console.log(`[Janitor] 📋 Trovate ${sessions.length} sessioni con file FLAC (${sessions.filter(s => !s.hasMaster).length} senza mix).`);

        // 3. Retention pass, BEFORE the storage check.
        //
        // Order matters here and it is the whole point of this change: the
        // threshold check below returns early on any instance under 8 GB, so an
        // age-based pass placed after it would never run on precisely the small
        // instances where raw voice was accumulating forever.
        await pruneExpiredRawAudio(sessions);

        // 4. Storage pressure pass: only when the bucket is actually filling up.
        if (stats.totalGB < TRIGGER_THRESHOLD_GB) {
            console.log(`[Janitor] 🟢 Spazio sufficiente (sotto soglia ${TRIGGER_THRESHOLD_GB} GB). Nessuna pulizia per spazio.`);
            return;
        }

        console.log(`[Janitor] ⚠️ Spazio critico! Avvio procedura di pulizia fino a raggiungere ${TARGET_THRESHOLD_GB} GB.`);
        let currentUsageGB = stats.totalGB;
        let deletedSessionsCount = 0;

        for (const session of sessions) {
            if (currentUsageGB <= TARGET_THRESHOLD_GB) {
                console.log(`[Janitor] 🏁 Obiettivo raggiunto (${currentUsageGB.toFixed(2)} GB). Interruzione pulizia.`);
                break;
            }

            console.log(`[Janitor] 🗑️ Pulizia sessione del ${session.date.toISOString()} (ID: ${session.id})...`);

            // When the master is missing, generate it before deleting the FLAC files
            if (!session.hasMaster) {
                try {
                    console.log(`[Janitor] 📀 Mix mancante per ${session.id}, generazione in corso...`);
                    await mixSessionAudio(session.id, false);
                    console.log(`[Janitor] ✅ Mix generato per ${session.id}.`);
                } catch (mixErr: any) {
                    console.warn(`[Janitor] ⚠️ Mix fallito per ${session.id}: ${mixErr.message}. Salto pulizia FLAC.`);
                    continue; // Do not delete the FLAC files when the mix failed
                }
            }

            const deletedCount = await deleteRawSessionFiles(session.id);

            if (deletedCount > 0) {
                deletedSessionsCount++;
                if (deletedSessionsCount % 3 === 0) {
                    const updatedStats = await checkStorageUsage(true);
                    currentUsageGB = updatedStats.totalGB;
                    console.log(`[Janitor] 📉 Storage aggiornato: ${currentUsageGB.toFixed(2)} GB`);
                }
            } else {
                console.log(`[Janitor] ⏩ Sessione già pulita o vuota.`);
            }
        }

        // Final report
        const finalStats = await checkStorageUsage(true);
        console.log(`[Janitor] ✅ Ciclo terminato. Storage finale: ${finalStats.totalGB.toFixed(2)} GB. Pulite ${deletedSessionsCount} sessioni.`);

    } catch (err) {
        console.error(`[Janitor] ❌ Errore critico durante il ciclo:`, err);
    }
}

/**
 * Atomic DB backup: uses SQLite .backup() to create a snapshot,
 * uploads to OCI bucket, then cleans up old backups (retention: 7 days).
 */
async function runDbBackup() {
    if (!DB_BACKUP_BUCKET) {
        log.info('OCI_DB_BACKUP_BUCKET not configured: DB backup skipped.');
        return;
    }

    const backupDir = path.join(__dirname, '..', '..', 'data');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFileName = `dnd_bot_backup_${timestamp}.db`;
    const backupPath = path.join(backupDir, backupFileName);
    const remoteKey = `snapshots/${backupFileName}`;

    try {
        // 1. Atomic SQLite backup
        log.info('Avvio backup atomico DB...');
        await db.backup(backupPath);

        const localSize = fs.statSync(backupPath).size;
        if (localSize === 0) {
            throw new Error('Backup locale vuoto (0 bytes)');
        }
        log.info(`Backup locale creato: ${backupFileName} (${(localSize / 1024 / 1024).toFixed(1)} MB)`);

        // 2. Upload to OCI
        const client = getS3Client();
        const fileContent = fs.readFileSync(backupPath);

        await client.send(new PutObjectCommand({
            Bucket: DB_BACKUP_BUCKET,
            Key: remoteKey,
            Body: fileContent,
            ContentType: 'application/x-sqlite3',
        }));

        // 3. Verify upload: check remote file exists and size matches
        const head = await client.send(new HeadObjectCommand({
            Bucket: DB_BACKUP_BUCKET,
            Key: remoteKey,
        }));

        const remoteSize = head.ContentLength ?? 0;
        if (remoteSize === 0) {
            throw new Error(`Backup remoto vuoto: ${remoteKey}`);
        }
        if (remoteSize !== localSize) {
            throw new Error(`Size mismatch: locale=${localSize} remoto=${remoteSize} per ${remoteKey}`);
        }

        log.info(`Backup verificato su OCI: ${remoteKey} (${(remoteSize / 1024 / 1024).toFixed(1)} MB)`);

        // 4. Cleanup local backup file
        fs.unlinkSync(backupPath);

        // 5. Prune old remote backups (> 7 days)
        await pruneOldBackups(client);

        // 6. Success alert (only log, no DM spam for success)
        log.info('Backup DB completato con successo.');

    } catch (err) {
        log.error('Errore durante backup DB', err as Error);
        await sendBackupAlert(
            `Backup DB fallito: ${(err as Error).message}\n` +
            `File: \`${backupFileName}\`\n` +
            `Timestamp: ${new Date().toISOString()}`,
            true
        );
        // Cleanup local file on error
        try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
}

async function pruneOldBackups(client: ReturnType<typeof getS3Client>) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - DB_BACKUP_RETENTION_DAYS);

    let continuationToken: string | undefined;
    let deletedCount = 0;

    do {
        const response = await client.send(new ListObjectsV2Command({
            Bucket: DB_BACKUP_BUCKET,
            Prefix: 'snapshots/',
            ContinuationToken: continuationToken,
        }));

        if (response.Contents) {
            for (const obj of response.Contents) {
                if (obj.LastModified && obj.LastModified < cutoffDate && obj.Key) {
                    await client.send(new DeleteObjectCommand({
                        Bucket: DB_BACKUP_BUCKET,
                        Key: obj.Key,
                    }));
                    deletedCount++;
                }
            }
        }
        continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    if (deletedCount > 0) {
        log.info(`Rimossi ${deletedCount} backup più vecchi di ${DB_BACKUP_RETENTION_DAYS} giorni.`);
    }
}

/**
 * Purges all derived data from a session (DB, RAG, Character Sync)
 * Used by $reset and $reprocess commands.
 */
export function purgeSessionData(sessionId: string, clearCache: boolean = false) {
    console.log(`[Janitor] 🧹 Purge completo dati derivati per sessione ${sessionId} (ClearCache: ${clearCache})...`);

    // 0. Context
    const session = db.prepare('SELECT campaign_id FROM sessions WHERE session_id = ?').get(sessionId) as { campaign_id: number } | undefined;
    const campaignId = session?.campaign_id;

    // 1. Reset Character Sync State
    if (campaignId) {
        const affectedChars = db.prepare('SELECT DISTINCT character_name FROM character_history WHERE session_id = ?').all(sessionId) as { character_name: string }[];
        for (const char of affectedChars) {
            console.log(`[Janitor] 🧹 Reset stato sync PG: ${char.character_name}`);
            db.prepare(`
                UPDATE characters 
                SET description = '', last_synced_history_id = 0, rag_sync_needed = 1 
                WHERE campaign_id = ? AND character_name = ?
            `).run(campaignId, char.character_name);

            // Also delete RAG character summary just in case (wildcard LIKE escapati)
            db.prepare(`
                DELETE FROM knowledge_fragments
                WHERE session_id = 'CHARACTER_UPDATE'
                AND associated_npcs LIKE ? ESCAPE '\\'
            `).run(`%${char.character_name.replace(/[\\%_]/g, (m: string) => `\\${m}`)}%`);
        }
    }

    // 2. Delete Derived Data (DB Tables) - history events
    db.prepare('DELETE FROM session_logs WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM location_history WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM npc_history WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM world_history WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM character_history WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM quest_lifecycle_suggestions WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM quests WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM inventory WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM bestiary WHERE session_id = ?').run(sessionId);

    // 2b. Reset NPC/Location descriptions (KEEPS THE NAMES, only resets the descriptions)
    // This avoids duplication on reprocess: the new description will not be merged with the old one
    const npcReset = db.prepare(`
        UPDATE npc_dossier
        SET description = NULL, rag_sync_needed = 1
        WHERE last_updated_session_id = ?
        AND COALESCE(is_manual, 0) = 0
    `).run(sessionId);
    if (npcReset.changes > 0) {
        console.log(`[Janitor] 🧹 Reset descrizioni per ${npcReset.changes} NPC.`);
    }

    const atlasReset = db.prepare(`
        UPDATE location_atlas
        SET description = NULL, rag_sync_needed = 1
        WHERE last_updated_session_id = ?
        AND COALESCE(is_manual, 0) = 0
    `).run(sessionId);
    if (atlasReset.changes > 0) {
        console.log(`[Janitor] 🧹 Reset descrizioni per ${atlasReset.changes} luoghi.`);
    }

    // 2c. Delete the NPCs/locations CREATED in this session (the ones that did not exist before)
    db.prepare('DELETE FROM npc_dossier WHERE first_session_id = ? AND last_updated_session_id = ? AND COALESCE(is_manual, 0) = 0').run(sessionId, sessionId);
    db.prepare('DELETE FROM location_atlas WHERE first_session_id = ? AND last_updated_session_id = ? AND COALESCE(is_manual, 0) = 0').run(sessionId, sessionId);

    // 2d. Optional: Clear AI Cache (Analyst/Summary Data)
    if (clearCache) {
        db.prepare(`
            UPDATE sessions 
            SET analyst_data = NULL, summary_data = NULL, last_generated_at = NULL 
            WHERE session_id = ?
        `).run(sessionId);
        console.log(`[Janitor] 🧹 Cache AI eliminata per sessione ${sessionId}.`);
    }

    // 3. Delete RAG Vectors (Knowledge Fragments)
    // Deletes chunks generated by this session's summary/events
    const ragResult = db.prepare('DELETE FROM knowledge_fragments WHERE session_id = ?').run(sessionId);
    console.log(`[Janitor] 🧹 Cancellati ${ragResult.changes} frammenti RAG.`);

    console.log(`[Janitor] ✅ Pulizia sessione ${sessionId} completata.`);
}
