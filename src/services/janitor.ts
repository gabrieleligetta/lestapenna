import * as cron from 'node-cron';
import { ListObjectsV2Command, ListObjectsV2CommandOutput } from "@aws-sdk/client-s3";
import { deleteRawSessionFiles, getS3Client, getBucketName, checkStorageUsage } from './backup';
import { db } from '../db';

// Configurazione
const JANITOR_SCHEDULE = '0 4 * * *'; // Ogni giorno alle 04:00
const RETENTION_HOURS = 48; // Ore di conservazione dopo la creazione del Master

export function startJanitor() {
    console.log(`[Janitor] 🧹 Servizio di pulizia programmato: ${JANITOR_SCHEDULE}`);

    cron.schedule(JANITOR_SCHEDULE, async () => {
        console.log(`[Janitor] 🧹 Inizio ciclo di pulizia giornaliero...`);
        await runJanitorCycle();
        console.log(`[Janitor] 💤 Ciclo terminato. Prossima esecuzione domani.`);
    });
}

async function runJanitorCycle() {
    console.log(`[Janitor] 🧹 Inizio ciclo di pulizia intelligente...`);
    const client = getS3Client();
    const bucket = getBucketName();

    try {
        // 1. Check Space Usage First
        const stats = await checkStorageUsage(true); // silent check
        console.log(`[Janitor] 📊 Storage attuale: ${stats.totalGB.toFixed(2)} GB / ${stats.freeTierLimitGB} GB (${stats.percentUsed.toFixed(1)}%)`);

        // THRESHOLDS
        const TRIGGER_THRESHOLD_GB = 8.0; // Start cleaning if > 8GB
        const TARGET_THRESHOLD_GB = 7.0;  // Stop cleaning when < 7GB

        if (stats.totalGB < TRIGGER_THRESHOLD_GB) {
            console.log(`[Janitor] 🟢 Spazio sufficiente (sotto soglia ${TRIGGER_THRESHOLD_GB} GB). Nessuna pulizia necessaria.`);
            return;
        }

        console.log(`[Janitor] ⚠️ Spazio critico! Avvio procedura di pulizia fino a raggiungere ${TARGET_THRESHOLD_GB} GB.`);

        // 2. We need to clear space. List ALL sessions with their Master File Date.
        let sessions: { id: string, date: Date }[] = [];
        let continuationToken: string | undefined = undefined;

        console.log(`[Janitor] 🔍 Indicizzazione sessioni masterizzate...`);

        do {
            const listCmd: ListObjectsV2Command = new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: 'recordings/',
                ContinuationToken: continuationToken
            });

            const response: ListObjectsV2CommandOutput = await client.send(listCmd);

            if (response.Contents) {
                for (const obj of response.Contents) {
                    // Check for master file to valid session existence and get date
                    if (obj.Key && obj.Key.endsWith('_master.mp3')) {
                        const parts = obj.Key.split('/');
                        if (parts.length >= 3) {
                            const sessionId = parts[1];
                            if (obj.LastModified) {
                                sessions.push({ id: sessionId, date: obj.LastModified });
                            }
                        }
                    }
                }
            }
            continuationToken = response.NextContinuationToken;
        } while (continuationToken);

        // Sort sessions by date ASC (Oldest first)
        sessions.sort((a, b) => a.date.getTime() - b.date.getTime());
        console.log(`[Janitor] 📋 Trovate ${sessions.length} sessioni archiviate.`);

        // 3. Start Pruning Loop
        let currentUsageGB = stats.totalGB;
        let deletedSessionsCount = 0;

        for (const session of sessions) {
            if (currentUsageGB <= TARGET_THRESHOLD_GB) {
                console.log(`[Janitor] 🏁 Obiettivo raggiunto (${currentUsageGB.toFixed(2)} GB). Interruzione pulizia.`);
                break;
            }

            console.log(`[Janitor] 🗑️ Pulizia sessione del ${session.date.toISOString()} (ID: ${session.id})...`);

            // Delete RAW files only (keep Master/Live/Transcript)
            // Note: deleteRawSessionFiles returns number of files, not bytes freed unfortunately.
            // We'll trust that deleting files frees space. We could estimate size but it's slow.
            // We just proceed aggressively session by session.
            const deletedCount = await deleteRawSessionFiles(session.id);

            if (deletedCount > 0) {
                deletedSessionsCount++;
                // ESTIMATION: average raw session might be 100-200MB? 
                // Since we can't query size constantly without cost/latency, we just clean one by one.
                // Re-checking storage every single session is too API heavy.
                // Let's re-check storage every 3 sessions cleaned.
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

// Note: getS3Client e getBucketName sono esportati da backup.ts

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

            // Also delete RAG character summary just in case
            db.prepare(`
                DELETE FROM knowledge_fragments
                WHERE session_id = 'CHARACTER_UPDATE'
                AND associated_npcs LIKE ?
            `).run(`%${char.character_name}%`);
        }
    }

    // 2. Delete Derived Data (DB Tables) - Eventi storici
    db.prepare('DELETE FROM session_logs WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM location_history WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM npc_history WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM world_history WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM character_history WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM quests WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM inventory WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM bestiary WHERE session_id = ?').run(sessionId);

    // 2b. Reset NPC/Location descriptions (PRESERVA I NOMI, resetta solo le descrizioni)
    // Questo evita duplicazioni quando si fa reprocess: la nuova descrizione non verrà mergiata con quella vecchia
    const npcReset = db.prepare(`
        UPDATE npc_dossier
        SET description = NULL, rag_sync_needed = 1
        WHERE last_updated_session_id = ?
    `).run(sessionId);
    if (npcReset.changes > 0) {
        console.log(`[Janitor] 🧹 Reset descrizioni per ${npcReset.changes} NPC.`);
    }

    const atlasReset = db.prepare(`
        UPDATE location_atlas
        SET description = NULL, rag_sync_needed = 1
        WHERE last_updated_session_id = ?
    `).run(sessionId);
    if (atlasReset.changes > 0) {
        console.log(`[Janitor] 🧹 Reset descrizioni per ${atlasReset.changes} luoghi.`);
    }

    // 2c. Cancella NPC/luoghi CREATI in questa sessione (quelli che non esistevano prima)
    db.prepare('DELETE FROM npc_dossier WHERE first_session_id = ? AND last_updated_session_id = ?').run(sessionId, sessionId);
    db.prepare('DELETE FROM location_atlas WHERE first_session_id = ? AND last_updated_session_id = ?').run(sessionId, sessionId);

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
