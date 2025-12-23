import { Worker } from 'bullmq';
import * as fs from 'fs';
import { updateRecordingStatus, getUserName, getRecording } from './db';
import { convertPcmToWav, transcribeLocal } from './transcriptionService';
import { downloadFromOracle, uploadToOracle } from './backupService';

// Worker BullMQ - LO SCRIBA
// Questo worker si occupa SOLO di trascrivere e salvare nel DB.
// Non genera riassunti. Non chiama OpenAI. È un operaio puro.

export function startWorker() {
    const worker = new Worker('audio-processing', async job => {
        const { sessionId, fileName, filePath, userId } = job.data;
        const userName = getUserName(userId) || userId;

        // Idempotenza: controlliamo se il file è già stato processato
        const currentRecording = getRecording(fileName);
        if (currentRecording && (currentRecording.status === 'PROCESSED' || currentRecording.status === 'SKIPPED')) {
            console.log(`[Scriba] ⏩ File ${fileName} già elaborato (stato: ${currentRecording.status}). Salto.`);
            return { status: 'already_done', reason: currentRecording.status };
        }

        console.log(`[Scriba] 🔨 Inizio elaborazione: ${fileName} (Sessione: ${sessionId}) - Utente: ${userName}`);
        
        updateRecordingStatus(fileName, 'PROCESSING');

        try {
            if (!fs.existsSync(filePath)) {
                console.warn(`[Scriba] ⚠️ File non trovato localmente: ${fileName}. Tento ripristino dal Cloud...`);
                const success = await downloadFromOracle(fileName, filePath, sessionId);
                if (!success) {
                    console.error(`[Scriba] ❌ File non trovato nemmeno su Oracle: ${fileName}`);
                    updateRecordingStatus(fileName, 'ERROR', null, 'File non trovato su disco né su Cloud');
                    return { status: 'failed', reason: 'file_not_found' };
                }
            }

            const stats = fs.statSync(filePath);
            if (stats.size < 20000) {
                console.log(`[Scriba] 🗑️  File ${fileName} scartato (troppo piccolo: ${stats.size} bytes)`);
                updateRecordingStatus(fileName, 'SKIPPED', null, 'File troppo piccolo');
                try { fs.unlinkSync(filePath); } catch(e) {}
                return { status: 'skipped', reason: 'too_small' };
            }

            let transcriptionPath = filePath;
            const extension = filePath.toLowerCase().split('.').pop();
            const isPcm = extension === 'pcm';

            if (isPcm) {
                const wavPath = filePath.replace('.pcm', '.wav');
                console.log(`[Scriba] 🔄 Conversione in WAV (Legacy PCM): ${fileName}`);
                await convertPcmToWav(filePath, wavPath);
                transcriptionPath = wavPath;
            }
            
            console.log(`[Scriba] 🗣️  Inizio trascrizione Whisper: ${fileName}`);
            const result = await transcribeLocal(transcriptionPath);
            
            // Pulizia del file temporaneo WAV se è stato creato
            if (transcriptionPath !== filePath && fs.existsSync(transcriptionPath)) {
                fs.unlinkSync(transcriptionPath);
            }

            if (result && result.text && result.text.trim().length > 0) {
                updateRecordingStatus(fileName, 'PROCESSED', result.text.trim());
                console.log(`[Scriba] ✅ Trascritto ${fileName}: "${result.text.substring(0, 30)}..."`);
                
                // --- PULIZIA FINALE ---
                // Verifichiamo il backup prima di eliminare il locale
                const isBackedUp = await uploadToOracle(filePath, fileName, sessionId);
                if (isBackedUp) {
                    try {
                        fs.unlinkSync(filePath);
                        console.log(`[Scriba] 🧹 File locale eliminato dopo backup: ${fileName}`);
                    } catch (err) {
                        console.error(`[Scriba] ❌ Errore durante eliminazione locale ${fileName}:`, err);
                    }
                } else {
                    console.warn(`[Scriba] ⚠️ Backup non confermato per ${fileName}, mantengo file locale.`);
                }

                return { status: 'ok', text: result.text };
            } else {
                updateRecordingStatus(fileName, 'SKIPPED', null, 'Silenzio o incomprensibile');
                console.log(`[Scriba] 🔇 Audio ${fileName} scartato (silenzio o incomprensibile)`);

                // Anche se scartato, se abbiamo il backup possiamo pulire il locale
                const isBackedUp = await uploadToOracle(filePath, fileName, sessionId);
                if (isBackedUp) {
                    try { fs.unlinkSync(filePath); } catch(e) {}
                }

                return { status: 'skipped', reason: 'silence' };
            }

        } catch (e: any) {
            console.error(`[Scriba] ❌ Errore trascrizione ${fileName}: ${e.message}`);
            updateRecordingStatus(fileName, 'ERROR', null, e.message);
            throw e; 
        }
    }, { 
        connection: { 
            host: process.env.REDIS_HOST || 'redis', 
            port: parseInt(process.env.REDIS_PORT || '6379') 
        },
        concurrency: 3
    });

    worker.on('failed', (job, err) => {
        const attemptsMade = job?.attemptsMade || 0;
        const maxAttempts = job?.opts.attempts || 1;
        if (attemptsMade < maxAttempts) {
            console.warn(`[Scriba] Job ${job?.id} fallito (tentativo ${attemptsMade}/${maxAttempts}): ${err.message}. Riprovo...`);
        } else {
            console.error(`[Scriba] Job ${job?.id} fallito DEFINITIVAMENTE dopo ${attemptsMade} tentativi: ${err.message}`);
        }
    });

    console.log("[Scriba] Worker avviato e in attesa di pergamene...");
    return worker;
}
