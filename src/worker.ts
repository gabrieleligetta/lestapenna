import { Worker } from 'bullmq';
import * as fs from 'fs';
import { updateRecordingStatus, getUserName, getRecording, getSessionCampaignId } from './db';
import { convertPcmToWav, transcribeLocal } from './transcriptionService';
import { downloadFromOracle, uploadToOracle } from './backupService';
import { monitor } from './monitor';

// Worker BullMQ - LO SCRIBA
// Questo worker si occupa SOLO di trascrivere e salvare nel DB.
// Non genera riassunti. Non chiama OpenAI. È un operaio puro.

export function startWorker() {
    const worker = new Worker('audio-processing', async job => {
        const { sessionId, fileName, filePath, userId } = job.data;
        
        // Recuperiamo il campaignId dalla sessione per ottenere il nome corretto
        const campaignId = getSessionCampaignId(sessionId);
        // Se non c'è campagna (vecchia sessione), passiamo un valore dummy o gestiamo il null in getUserName
        // getUserName ora richiede 2 argomenti. Se campaignId è undefined, usiamo 0 o gestiamo il fallback.
        // Tuttavia, getUserName è pensato per il contesto campagna.
        // Se è una sessione legacy senza campagna, il nome sarà null o useremo userId.
        
        const userName = (campaignId ? getUserName(userId, campaignId) : null) || userId;
        const startJob = Date.now();

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
                    monitor.logError('Worker', `File non trovato: ${fileName}`);
                    return { status: 'failed', reason: 'file_not_found' };
                }
            }

            const stats = fs.statSync(filePath);
            // SOGLIA RICALIBRATA: 5000 bytes (~0.6s di MP3 a 64kbps)
            // Filtra rumori brevissimi ma mantiene parole monosillabiche ("Sì", "No", "Via")
            if (stats.size < 5000) {
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

            // CALCOLO DURATA AUDIO (Approssimativa dal size o dai segmenti)
            let audioDuration = 0;
            if (result.segments && result.segments.length > 0) {
                audioDuration = result.segments[result.segments.length - 1].end;
            }

            // LOG AL MONITOR
            const processingTime = Date.now() - startJob;
            monitor.logFileProcessed(audioDuration, processingTime);

            // Se abbiamo segmenti, salviamo il JSON completo
            if (result.segments && result.segments.length > 0) {
                const jsonStr = JSON.stringify(result.segments);
                
                // Calcoliamo un testo "flat" per log e fallback rapido
                const flatText = result.segments.map((s: any) => s.text).join(" ");
                
                updateRecordingStatus(fileName, 'PROCESSED', jsonStr);
                console.log(`[Scriba] ✅ Trascritto ${fileName} (${result.segments.length} segmenti): "${flatText.substring(0, 30)}..."`);
                
                // --- PULIZIA FINALE ---
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

                return { status: 'ok', segments: result.segments };
            } else {
                // Fallback per casi strani o vuoti
                updateRecordingStatus(fileName, 'SKIPPED', null, 'Silenzio o incomprensibile');
                console.log(`[Scriba] 🔇 Audio ${fileName} scartato (silenzio o incomprensibile)`);

                const isBackedUp = await uploadToOracle(filePath, fileName, sessionId);
                if (isBackedUp) {
                    try { fs.unlinkSync(filePath); } catch(e) {}
                }

                return { status: 'skipped', reason: 'silence' };
            }

        } catch (e: any) {
            console.error(`[Scriba] ❌ Errore trascrizione ${fileName}: ${e.message}`);
            updateRecordingStatus(fileName, 'ERROR', null, e.message);
            monitor.logError('Worker', `File: ${fileName} - ${e.message}`);
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
