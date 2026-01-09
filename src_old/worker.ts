import { Worker, Job } from 'bullmq';
import * as fs from 'fs';
import { updateRecordingStatus, getUserName, getRecording, getSessionCampaignId, updateLocation, getCampaignLocationById, updateAtlasEntry, updateNpcEntry, getUserProfile } from './db';
// MODIFICA 1: Importiamo solo transcribeLocal, la conversione è interna al servizio ora
import { transcribeLocal } from './transcriptionService';
import { downloadFromOracle, uploadToOracle } from './backupService';
import { monitor } from './monitor';
import { correctTranscription } from './bard';
import { correctionQueue } from './queue';

// Worker BullMQ - LO SCRIBA (Audio Worker)
const ENABLE_AI_TRANSCRIPTION_CORRECTION = process.env.ENABLE_AI_TRANSCRIPTION_CORRECTION !== 'false';

export function startWorker() {
    // --- WORKER 1: AUDIO PROCESSING ---
    const audioWorker = new Worker('audio-processing', async job => {
        const { sessionId, fileName, filePath, userId } = job.data;

        const campaignId = getSessionCampaignId(sessionId);
        const userName = (campaignId ? getUserName(userId, campaignId) : null) || userId;
        const startJob = Date.now();

        // Idempotenza & Recupero "Buco Nero"
        const currentRecording = getRecording(fileName);

        if (currentRecording) {
            if (currentRecording.status === 'PROCESSED' || currentRecording.status === 'SKIPPED') {
                console.log(`[Scriba] ⏩ File ${fileName} già elaborato. Salto.`);
                return { status: 'already_done', reason: currentRecording.status };
            }

            if (currentRecording.status === 'TRANSCRIBED') {
                console.log(`[Scriba] ⚠️ File ${fileName} trovato in stato TRANSCRIBED. Tento recupero...`);
                try {
                    const segments = JSON.parse(currentRecording.transcription_text || '[]');
                    if (segments.length > 0 && ENABLE_AI_TRANSCRIPTION_CORRECTION) {
                        await correctionQueue.add('correction-job', {
                            sessionId, fileName, segments, campaignId, userId
                        }, { jobId: `correct-${fileName}-${Date.now()}`, removeOnComplete: true });
                        return { status: 'recovered_to_correction' };
                    }
                } catch (e) {
                    console.error(`[Scriba] ❌ Errore recupero JSON, procedo con ritrascrizione.`);
                }
            }
        }

        console.log(`[Scriba] 🔨 Inizio elaborazione: ${fileName} (Sessione: ${sessionId})`);
        updateRecordingStatus(fileName, 'PROCESSING');

        try {
            // 1. Recupero File
            if (!fs.existsSync(filePath)) {
                console.warn(`[Scriba] ⚠️ File locale mancante. Tento download Cloud...`);
                const success = await downloadFromOracle(fileName, filePath, sessionId);
                if (!success) {
                    updateRecordingStatus(fileName, 'ERROR', null, 'File non trovato');
                    return { status: 'failed', reason: 'file_not_found' };
                }
            }

            const stats = fs.statSync(filePath);
            if (stats.size < 5000) {
                console.log(`[Scriba] 🗑️ File troppo piccolo (${stats.size} bytes). Scartato.`);
                updateRecordingStatus(fileName, 'SKIPPED', null, 'File troppo piccolo');
                try { fs.unlinkSync(filePath); } catch(e) {}
                return { status: 'skipped', reason: 'too_small' };
            }

            // 2. TRASCRIZIONE (Logica Semplificata)
            // Non ci preoccupiamo più se è PCM, MP3 o altro.
            // Il servizio gestisce la conversione automatica in WAV 16kHz per Whisper.
            console.log(`[Scriba] 🗣️  Inizio trascrizione intelligente: ${fileName}`);

            const result = await transcribeLocal(filePath);

            // 3. Gestione Risultato
            let audioDuration = 0;
            if (result.segments && result.segments.length > 0) {
                audioDuration = result.segments[result.segments.length - 1].end;
            }

            const processingTime = Date.now() - startJob;
            monitor.logFileProcessed(audioDuration, processingTime);

            if (result.segments && result.segments.length > 0) {
                const rawJson = JSON.stringify(result.segments);
                updateRecordingStatus(fileName, 'TRANSCRIBED', rawJson);

                // Backup su Oracle (Se non è già stato fatto dal recorder)
                const isBackedUp = await uploadToOracle(filePath, fileName, sessionId);
                if (isBackedUp) {
                    try {
                        fs.unlinkSync(filePath);
                        console.log(`[Scriba] 🧹 File locale eliminato dopo backup: ${fileName}`);
                    } catch (err) { console.error(`[Scriba] Errore pulizia:`, err); }
                }

                // 4. Accodamento Correzione
                if (ENABLE_AI_TRANSCRIPTION_CORRECTION) {
                    console.log(`[Scriba] 🧠 Invio a Correzione AI...`);
                    await correctionQueue.add('correction-job', {
                        sessionId, fileName, segments: result.segments, campaignId, userId
                    }, { jobId: `correct-${fileName}-${Date.now()}`, removeOnComplete: true });

                    return { status: 'transcribed_queued_correction', segmentsCount: result.segments.length };
                } else {
                    console.log(`[Scriba] ⏩ Correzione AI OFF. Completato.`);
                    updateRecordingStatus(fileName, 'PROCESSED', rawJson, null, null, null, [], null);
                    return { status: 'completed_raw', segmentsCount: result.segments.length };
                }

            } else {
                updateRecordingStatus(fileName, 'SKIPPED', null, 'Silenzio o incomprensibile');
                console.log(`[Scriba] 🔇 Audio scartato (silenzio).`);
                await uploadToOracle(filePath, fileName, sessionId);
                try { fs.unlinkSync(filePath); } catch(e) {}
                return { status: 'skipped', reason: 'silence' };
            }

        } catch (e: any) {
            console.error(`[Scriba] ❌ Errore critico: ${e.message}`);
            updateRecordingStatus(fileName, 'ERROR', null, e.message);
            throw e;
        }
    }, {
        connection: { host: process.env.REDIS_HOST || 'redis', port: parseInt(process.env.REDIS_PORT || '6379') },
        concurrency: 1,
        lockDuration: 27200000,
        lockRenewTime: 60000,
        maxStalledCount: 0,
    });

    // --- WORKER 2: CORRECTION PROCESSING (Invariato) ---
    const correctionWorker = new Worker('correction-processing', async job => {
        const { sessionId, fileName, segments, campaignId, userId } = job.data;
        console.log(`[Correttore] 🧠 Analisi AI per ${fileName}...`);

        try {
            const aiResult = await correctTranscription(segments, campaignId);
            const correctedSegments = aiResult.segments;

            let finalMacro = null;
            let finalMicro = null;

            if (campaignId) {
                const current = getCampaignLocationById(campaignId);
                const loc = aiResult.detected_location;

                const newMacro = loc?.macro || current?.macro || null;
                const newMicro = loc?.micro || null;

                if (newMacro !== current?.macro || newMicro !== current?.micro) {
                    console.log(`[Worker] 🗺️ Cambio luogo: ${newMacro} - ${newMicro}`);
                    updateLocation(campaignId, newMacro, newMicro, sessionId);
                }
                finalMacro = newMacro;
                finalMicro = newMicro;

                if (aiResult.atlas_update && finalMacro && finalMicro) {
                    updateAtlasEntry(campaignId, finalMacro, finalMicro, aiResult.atlas_update);
                }
                if (aiResult.npc_updates) {
                    for (const npc of aiResult.npc_updates) {
                        if (npc.name && npc.description) {
                            updateNpcEntry(campaignId, npc.name, npc.description, npc.role, npc.status);
                        }
                    }
                }
            }

            const jsonStr = JSON.stringify(correctedSegments);
            const presentNpcs = aiResult.present_npcs || [];

            let frozenCharName = null;
            if (userId && campaignId) {
                const profile = getUserProfile(userId, campaignId);
                frozenCharName = profile.character_name || null;
            }

            updateRecordingStatus(fileName, 'PROCESSED', jsonStr, null, finalMacro, finalMicro, presentNpcs, frozenCharName);
            console.log(`[Correttore] ✅ Completato ${fileName}.`);
            return { status: 'ok', segments: correctedSegments };

        } catch (e: any) {
            console.error(`[Correttore] ❌ Errore: ${e.message}`);
            throw e;
        }
    }, {
        connection: { host: process.env.REDIS_HOST || 'redis', port: parseInt(process.env.REDIS_PORT || '6379') },
        concurrency: 5
    });

    const handleFailure = (workerName: string) => async (job: Job | undefined, err: Error) => {
        console.error(`[${workerName}] 💀 Job ${job?.id} fallito: ${err.message}`);
        if ((job?.attemptsMade || 0) >= (job?.opts.attempts || 1)) {
            if (job?.data?.fileName) updateRecordingStatus(job.data.fileName, 'ERROR', null, err.message);
        }
    };

    audioWorker.on('failed', handleFailure('Scriba'));
    correctionWorker.on('failed', handleFailure('Correttore'));

    console.log("[System] Workers Scriba e Correttore avviati.");
    return { audioWorker, correctionWorker };
}
