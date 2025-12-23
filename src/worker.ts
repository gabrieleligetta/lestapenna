import { Worker } from 'bullmq';
import * as fs from 'fs';
import { updateRecordingStatus } from './db';
import { convertPcmToWav, transcribeLocal } from './transcriptionService';

// Worker BullMQ - LO SCRIBA
// Questo worker si occupa SOLO di trascrivere e salvare nel DB.
// Non genera riassunti. Non chiama OpenAI. È un operaio puro.

const worker = new Worker('audio-processing', async job => {
    const { sessionId, fileName, filePath, userId } = job.data;
    console.log(`[Scriba] 🔨 Elaborazione job: ${fileName} (Sessione: ${sessionId})`);
    
    try {
        // 1. Verifica esistenza file
        if (!fs.existsSync(filePath)) {
            // Se il file non c'è, potrebbe essere stato cancellato o spostato.
            // Segniamo come errore ma non blocchiamo la coda.
            updateRecordingStatus(fileName, 'ERROR', null, 'File non trovato su disco');
            return { status: 'failed', reason: 'file_not_found' };
        }

        // 2. Filtro dimensione
        const stats = fs.statSync(filePath);
        if (stats.size < 20000) {
            console.log(`[Scriba] 🗑️ File troppo piccolo scartato: ${fileName}`);
            updateRecordingStatus(fileName, 'SKIPPED', null, 'File troppo piccolo');
            try { fs.unlinkSync(filePath); } catch(e) {}
            return { status: 'skipped', reason: 'too_small' };
        }

        // 3. Conversione e Trascrizione
        const wavPath = filePath.replace('.pcm', '.wav');
        await convertPcmToWav(filePath, wavPath);
        
        const result = await transcribeLocal(wavPath);
        
        // Pulizia WAV
        if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);

        // 4. Aggiornamento DB
        if (result && result.text && result.text.trim().length > 0) {
            // SALVIAMO IL TESTO GREZZO NEL DB
            // Lo status diventa 'PROCESSED' (che significa "Pronto per il Bardo")
            updateRecordingStatus(fileName, 'PROCESSED', result.text.trim());
            console.log(`[Scriba] ✅ Trascritto: "${result.text.substring(0, 30)}..."`);
            
            // Opzionale: Cancellare il PCM originale per risparmiare spazio
            // fs.unlinkSync(filePath); 

            return { status: 'ok', text: result.text };
        } else {
            updateRecordingStatus(fileName, 'SKIPPED', null, 'Silenzio o incomprensibile');
            console.log(`[Scriba] 🔇 Audio scartato (silenzio): ${fileName}`);
            return { status: 'skipped', reason: 'silence' };
        }

    } catch (e: any) {
        console.error(`[Scriba] ❌ Errore trascrizione ${fileName}: ${e.message}`);
        updateRecordingStatus(fileName, 'ERROR', null, e.message);
        throw e; // Rilancia per il retry di BullMQ
    }
}, { 
    connection: { 
        host: process.env.REDIS_HOST || 'redis', 
        port: parseInt(process.env.REDIS_PORT || '6379') 
    },
    concurrency: 2 // Limitiamo a 2 per non sovraccaricare la CPU con Whisper
});

worker.on('failed', (job, err) => {
    console.error(`[Scriba] Job ${job?.id} fallito definitivamente: ${err.message}`);
});

console.log("[Scriba] Worker avviato e in attesa di pergamene...");
