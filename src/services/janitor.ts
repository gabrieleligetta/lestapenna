import * as cron from 'node-cron';
import { ListObjectsV2Command, ListObjectsV2CommandOutput } from "@aws-sdk/client-s3";
import { deleteRawSessionFiles, getS3Client, getBucketName } from './backup';

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
