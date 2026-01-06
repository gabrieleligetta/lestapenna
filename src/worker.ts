import { Worker, Job } from 'bullmq';
import * as fs from 'fs';
import { updateRecordingStatus, getUserName, getRecording, getSessionCampaignId, updateLocation, getCampaignLocationById, updateAtlasEntry, updateNpcEntry, getUserProfile } from './db';
import { convertPcmToWav, transcribeLocal } from './transcriptionService';
import { downloadFromOracle, uploadToOracle } from './backupService';
import { monitor } from './monitor';
import { correctTranscription } from './bard';
import { correctionQueue } from './queue';

// Worker BullMQ - LO SCRIBA (Audio Worker)
// Si occupa di: Download -> Trascrizione -> Backup -> Accodamento Correzione

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
            // 1. Caso Completato o Skippato -> Esci
            if (currentRecording.status === 'PROCESSED' || currentRecording.status === 'SKIPPED') {
                console.log(`[Scriba] ⏩ File ${fileName} già elaborato (stato: ${currentRecording.status}). Salto.`);
                return { status: 'already_done', reason: currentRecording.status };
            }

            // 2. Caso "Limbo" (TRANSCRIBED ma non PROCESSED) -> Recupero
            // Se il server è crashato dopo la trascrizione ma prima dell'accodamento alla correzione
            if (currentRecording.status === 'TRANSCRIBED') {
                console.log(`[Scriba] ⚠️ File ${fileName} trovato in stato TRANSCRIBED. Tento recupero verso coda correzione...`);
                try {
                    const segments = JSON.parse(currentRecording.transcription_text || '[]');
                    if (segments.length > 0) {
                         await correctionQueue.add('correction-job', {
                            sessionId,
                            fileName,
                            segments: segments,
                            campaignId,
                            userId // Passiamo userId per recuperare lo snapshot nel correction worker
                        }, {
                            jobId: `correct-${fileName}-${Date.now()}`,
                            attempts: 3,
                            backoff: { type: 'exponential', delay: 2000 },
                            removeOnComplete: true
                        });
                        console.log(`[Scriba] ♻️  Recupero riuscito: ${fileName} ri-accodato per correzione.`);
                        return { status: 'recovered_to_correction' };
                    }
                } catch (e) {
                    console.error(`[Scriba] ❌ Errore recupero JSON per ${fileName}, procedo con ritrascrizione.`);
                    // Se fallisce il parse, lasciamo che il codice prosegua e ritrascriva
                }
            }
        }

        console.log(`[Scriba] 🔨 Inizio elaborazione: ${fileName} (Sessione: ${sessionId}) - Utente: ${userName}`);
        updateRecordingStatus(fileName, 'PROCESSING');

        try {
            // 1. Recupero File
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
            if (stats.size < 5000) {
                console.log(`[Scriba] 🗑️  File ${fileName} scartato (troppo piccolo: ${stats.size} bytes)`);
                updateRecordingStatus(fileName, 'SKIPPED', null, 'File troppo piccolo');
                try { fs.unlinkSync(filePath); } catch(e) {}
                return { status: 'skipped', reason: 'too_small' };
            }

            // 2. Conversione & Trascrizione
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
            
            if (transcriptionPath !== filePath && fs.existsSync(transcriptionPath)) {
                fs.unlinkSync(transcriptionPath);
            }

            // 3. Gestione Risultato
            let audioDuration = 0;
            if (result.segments && result.segments.length > 0) {
                audioDuration = result.segments[result.segments.length - 1].end;
            }

            const processingTime = Date.now() - startJob;
            monitor.logFileProcessed(audioDuration, processingTime);

            if (result.segments && result.segments.length > 0) {
                // Salviamo stato intermedio
                const rawJson = JSON.stringify(result.segments);
                updateRecordingStatus(fileName, 'TRANSCRIBED', rawJson);
                
                // Backup e Pulizia Locale
                const isBackedUp = await uploadToOracle(filePath, fileName, sessionId);
                if (isBackedUp) {
                    try {
                        fs.unlinkSync(filePath);
                        console.log(`[Scriba] 🧹 File locale eliminato dopo backup: ${fileName}`);
                    } catch (err) {
                        console.error(`[Scriba] ❌ Errore durante eliminazione locale ${fileName}:`, err);
                    }
                }

                // 4. Accodamento per Correzione AI
                console.log(`[Scriba] 🧠 Accodo ${fileName} per correzione AI...`);
                await correctionQueue.add('correction-job', {
                    sessionId,
                    fileName,
                    segments: result.segments,
                    campaignId,
                    userId // Passiamo userId per recuperare lo snapshot nel correction worker
                }, {
                    jobId: `correct-${fileName}-${Date.now()}`,
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 2000 },
                    removeOnComplete: true
                });

                return { status: 'transcribed', segmentsCount: result.segments.length };

            } else {
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
        concurrency: 1, // Teniamo basso per la CPU
        
        // --- AGGIUNTA FONDAMENTALE PER EVITARE "JOB STALLED" ---
        lockDuration: 27200000, // 2 ORE
        lockRenewTime: 60000, // Rinnova il lock ogni minuto
        maxStalledCount: 0,   // Non considerare mai il job come stalled se sta lavorando
        // -------------------------------------------------------
    });

    // --- WORKER 2: CORRECTION PROCESSING ---
    const correctionWorker = new Worker('correction-processing', async job => {
        const { sessionId, fileName, segments, campaignId, userId } = job.data;
        
        console.log(`[Correttore] 🧠 Inizio correzione AI per ${fileName}...`);
        
        try {
            const aiResult = await correctTranscription(segments, campaignId);
            const correctedSegments = aiResult.segments;
            
            let finalMacro = null;
            let finalMicro = null;

            // Logica Aggiornamento Luogo
            if (campaignId) {
                const current = getCampaignLocationById(campaignId);
                
                if (aiResult.detected_location) {
                    const loc = aiResult.detected_location;
                    
                    // Logica di merge: se l'AI manda null, manteniamo il vecchio MACRO, 
                    // ma il MICRO spesso cambia totalmente, quindi se è null potrebbe significare "fuori"
                    const newMacro = loc.macro || current?.macro || null;
                    const newMicro = loc.micro || null; // Se l'AI dice cambio scena ma micro è null, siamo "in giro" nel macro
                    
                    if (newMacro !== current?.macro || newMicro !== current?.micro) {
                        console.log(`[Worker] 🗺️ Cambio luogo rilevato: ${newMacro} - ${newMicro}`);
                        updateLocation(campaignId, newMacro, newMicro, sessionId);
                    }
                    
                    finalMacro = newMacro;
                    finalMicro = newMicro;
                } else {
                    // Se l'AI non rileva nulla, usiamo il luogo corrente della campagna
                    finalMacro = current?.macro || null;
                    finalMicro = current?.micro || null;
                }

                // 2. GESTIONE ATLANTE (Storico)
                if (aiResult.atlas_update && finalMacro && finalMicro) {
                    console.log(`[Atlas] ✍️ L'AI ha aggiornato la memoria di: ${finalMicro}`);
                    updateAtlasEntry(campaignId, finalMacro, finalMicro, aiResult.atlas_update);
                }

                // 3. GESTIONE DOSSIER NPC (Biografo)
                if (aiResult.npc_updates && Array.isArray(aiResult.npc_updates)) {
                    for (const npc of aiResult.npc_updates) {
                        if (npc.name && npc.description) {
                            console.log(`[Biografo] 👤 Rilevato NPC: ${npc.name}`);
                            updateNpcEntry(campaignId, npc.name, npc.description, npc.role, npc.status);
                        }
                    }
                }
            }

            const jsonStr = JSON.stringify(correctedSegments);
            const flatText = correctedSegments.map((s: any) => s.text).join(" ");
            
            // Salviamo anche i metadati di luogo nel record
            // E ora anche la lista degli NPC presenti!
            const presentNpcs = aiResult.present_npcs || [];

            // --- SNAPSHOT IDENTITÀ ---
            let frozenCharName = null;
            if (userId && campaignId) {
                const profile = getUserProfile(userId, campaignId);
                frozenCharName = profile.character_name || null;
            }
            // -------------------------

            updateRecordingStatus(fileName, 'PROCESSED', jsonStr, null, finalMacro, finalMicro, presentNpcs, frozenCharName);
            
            console.log(`[Correttore] ✅ Corretto ${fileName} (${correctedSegments.length} segmenti): "${flatText.substring(0, 30)}..." [Luogo: ${finalMacro}|${finalMicro}] [NPC: ${presentNpcs.length}] [PG: ${frozenCharName}]`);
            
            return { status: 'ok', segments: correctedSegments };

        } catch (e: any) {
            console.error(`[Correttore] ❌ Errore correzione ${fileName}: ${e.message}`);
            // Non segniamo come ERROR bloccante, ma magari riproviamo o lasciamo TRANSCRIBED?
            // Per ora lanciamo errore per far scattare il retry di BullMQ
            throw e;
        }
    }, {
        connection: { 
            host: process.env.REDIS_HOST || 'redis', 
            port: parseInt(process.env.REDIS_PORT || '6379') 
        },
        concurrency: 5 // Più alto perché è I/O bound (chiamate API)
    });

    // Gestione Errori Globale
    const handleFailure = (workerName: string) => async (job: Job | undefined, err: Error) => {
        const attemptsMade = job?.attemptsMade || 0;
        const maxAttempts = job?.opts.attempts || 1;
        
        if (attemptsMade >= maxAttempts) {
            console.error(`[${workerName}] 💀 Job ${job?.id} MORTO dopo ${attemptsMade} tentativi: ${err.message}`);
            
            // AGGIORNAMENTO DB: Segniamo come ERROR per evitare il limbo
            if (job?.data?.fileName) {
                try {
                    updateRecordingStatus(job.data.fileName, 'ERROR', null, `Job Failed: ${err.message}`);
                    console.log(`[${workerName}] 📝 Stato DB aggiornato a ERROR per ${job.data.fileName}`);
                } catch (dbErr) {
                    console.error(`[${workerName}] ❌ Impossibile aggiornare DB per job fallito:`, dbErr);
                }
            }
        } else {
            console.warn(`[${workerName}] ⚠️ Job ${job?.id} fallito (tentativo ${attemptsMade}/${maxAttempts}): ${err.message}. Riprovo...`);
        }
    };

    audioWorker.on('failed', handleFailure('Scriba'));
    correctionWorker.on('failed', handleFailure('Correttore'));

    console.log("[System] Workers avviati: Scriba (Audio) e Correttore (AI).");
    
    return { audioWorker, correctionWorker };
}
