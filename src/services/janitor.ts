import * as cron from 'node-cron';
import { ListObjectsV2Command, ListObjectsV2CommandOutput } from "@aws-sdk/client-s3";
import { deleteRawSessionFiles, getS3Client, getBucketName } from './backup';
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
    const client = getS3Client(); // Assumiamo che getS3Client sia esportata o accessibile, altrimenti importala
    const bucket = getBucketName();

    // 1. Lista tutte le cartelle sessione in recordings/
    // S3 non ha cartelle reali, quindi listiamo con delimitatore '/'
    // Ma recordings/sessionId/file è la struttura.
    // Possiamo listare tutto recordings/ e raggruppare per sessione, o iterare sui prefissi se S3 lo supporta bene.
    // Per semplicità e robustezza, scansioniamo tutto recordings/ e identifichiamo i master file.

    try {
        let continuationToken: string | undefined = undefined;
        const sessionsToCheck = new Set<string>();

        // Step 1: Trova tutte le sessioni che hanno un file Master
        console.log(`[Janitor] 🔍 Scansione bucket per trovare sessioni masterizzate...`);

        do {
            const listCmd: ListObjectsV2Command = new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: 'recordings/',
                ContinuationToken: continuationToken
            });

            const response: ListObjectsV2CommandOutput = await client.send(listCmd);

            if (response.Contents) {
                for (const obj of response.Contents) {
                    if (obj.Key && obj.Key.endsWith('_master.mp3')) {
                        // Key format: recordings/SESSION_ID/session_SESSION_ID_master.mp3
                        const parts = obj.Key.split('/');
                        if (parts.length >= 3) {
                            const sessionId = parts[1];

                            // Check età del file Master
                            const lastModified = obj.LastModified;
                            if (lastModified) {
                                const ageHours = (Date.now() - lastModified.getTime()) / (1000 * 60 * 60);
                                if (ageHours > RETENTION_HOURS) {
                                    sessionsToCheck.add(sessionId);
                                }
                            }
                        }
                    }
                }
            }
            continuationToken = response.NextContinuationToken;
        } while (continuationToken);

        console.log(`[Janitor] 🎯 Trovate ${sessionsToCheck.size} sessioni candidabili per la pulizia.`);

        // Step 2: Esegui pulizia per ogni sessione candidata
        for (const sessionId of sessionsToCheck) {
            await deleteRawSessionFiles(sessionId);
            console.log(`[Janitor] ✅ Sessione ${sessionId} pulita.`);
        }

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
