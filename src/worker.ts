import { Worker, Job } from 'bullmq';
import * as fs from 'fs';
import axios from 'axios';
import { updateRecordingStatus, getUserName, getRecording, getSessionCampaignId, getCampaignLocationById, getUserProfile, saveRawTranscription } from './db';
import { convertPcmToWav, transcribeLocal } from './transcriptionService';
import { downloadFromOracle, uploadToOracle, getPresignedUrl } from './backupService';
import { monitor } from './monitor';
import { correctTranscription } from './bard';
import { correctionQueue } from './queue';
import { filterWhisperHallucinations } from './whisperHallucinationFilter';

// --- CONFIGURAZIONE PC REMOTO ---
const REMOTE_WHISPER_URL = process.env.REMOTE_WHISPER_URL;
const REMOTE_TIMEOUT = 2700000; // 45 minuti

// Worker BullMQ - LO SCRIBA (Audio Worker)
// Si occupa di: Download -> Trascrizione -> Backup -> Accodamento Correzione

/**
 * Tenta trascrizione su PC remoto (es. Ryzen 7800X3D + large-v3-turbo),
 * fallback automatico su Whisper locale del server se:
 * - PC remoto non configurato
 * - PC remoto non raggiungibile
 * - Timeout o errore
 */
async function transcribeWithFallback(
    localPath: string,
    sessionId: string,
    fileName: string
): Promise<any> {

    // 🔥 TENTATIVO 1: PC Remoto via Tailscale
    if (REMOTE_WHISPER_URL) {
        try {
            // Genera presigned URL on-demand (valido 1 ora)
            console.log('[Scriba] 🔗 Generazione presigned URL per PC remoto...');
            const presignedUrl = await getPresignedUrl(fileName, sessionId, 3600);

            if (!presignedUrl) {
                console.warn('[Scriba] ⚠️ Impossibile generare presigned URL, uso fallback locale');
            } else {
                console.log('[Scriba] 🌐 Tentativo PC remoto...');
                const startRemote = Date.now();

                const response = await axios.post(
                    REMOTE_WHISPER_URL,
                    { fileUrl: presignedUrl },
                    {
                        timeout: REMOTE_TIMEOUT,
                        headers: { 'Content-Type': 'application/json' }
                    }
                );

                if (response.data && !response.data.error) {
                    const elapsed = ((Date.now() - startRemote) / 1000).toFixed(1);
                    console.log(`[Scriba] ✅ PC remoto completato in ${elapsed}s`);
                    return response.data;
                }

                throw new Error(response.data.error || 'Remote returned error');
            }

        } catch (error: any) {
            const isTimeout = error.code === 'ECONNABORTED' || error.message?.includes('timeout');
            const isNetworkError = error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENETUNREACH';

            if (isTimeout) {
                console.warn(`[Scriba] ⏱️ Timeout PC remoto dopo ${REMOTE_TIMEOUT / 1000}s`);
            } else if (isNetworkError) {
                console.warn(`[Scriba] 🔌 PC remoto non raggiungibile (spento o disconnesso)`);
            } else {
                console.warn(`[Scriba] ⚠️ Errore PC remoto: ${error.message}`);
            }
        }
    }

    // 🔄 FALLBACK: Whisper Locale (server)
    console.log('[Scriba] 💻 Uso Whisper locale (server)...');
    return await transcribeLocal(localPath);
}

export function startWorker() {
    // --- WORKER 1: AUDIO PROCESSING ---
    const audioWorker = new Worker('audio-processing', async job => {
        const { sessionId, fileName, filePath, userId } = job.data;

        const campaignId = getSessionCampaignId(sessionId);
        const userName = (campaignId ? getUserName(userId, campaignId) : null) || userId;
        const startJob = Date.now();
        const waitTime = startJob - job.timestamp; // BullMQ fornisce job.timestamp

        // Idempotenza & Recupero "Buco Nero"
        const currentRecording = getRecording(fileName);

        if (currentRecording) {
            // 1. Caso Completato o Skippato -> Esci
            if (currentRecording.status === 'PROCESSED' || currentRecording.status === 'SKIPPED') {
                console.log(`[Scriba] ⏩ File ${fileName} già elaborato (stato: ${currentRecording.status}). Salto.`);
                monitor.logJobProcessed(waitTime, job.attemptsMade);
                return { status: 'already_done', reason: currentRecording.status };
            }

            // 2. Caso "Limbo" (TRANSCRIBED ma non PROCESSED) -> Recupero
            // Se il server è crashato dopo la trascrizione ma prima dell'accodamento alla correzione
            if (currentRecording.status === 'TRANSCRIBED') {
                console.log(`[Scriba] ⚠️ File ${fileName} trovato in stato TRANSCRIBED. Tento recupero verso coda correzione...`);
                try {
                    const segments = JSON.parse(currentRecording.transcription_text || '[]');
                    if (segments.length > 0) {
                        // Controllo se la correzione è abilitata
                        if (process.env.ENABLE_AI_TRANSCRIPTION_CORRECTION !== 'false') {
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
                            monitor.logJobProcessed(waitTime, job.attemptsMade);
                            return { status: 'recovered_to_correction' };
                        } else {
                            // Se disabilitata, non possiamo fare molto qui perché il file è già TRANSCRIBED
                            // ma non PROCESSED. Potremmo forzare il processamento manuale, ma per ora lasciamo così
                            // o lo riprocessiamo come se fosse nuovo.
                            console.log(`[Scriba] ⚠️ Correzione disabilitata, ma file in limbo. Procedo con logica standard.`);
                        }
                    }
                } catch (e) {
                    console.error(`[Scriba] ❌ Errore recupero JSON per ${fileName}, procedo con ritrascrizione.`);
                    // Se fallisce il parse, lasciamo che il codice prosegua e ritrascriva
                }
            }
        }

        console.log(`[Scriba] 🗣️  Inizio trascrizione: ${fileName}`);
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
                    monitor.logJobFailed();
                    return { status: 'failed', reason: 'file_not_found' };
                }
            }

            const stats = fs.statSync(filePath);
            if (stats.size < 5000) {
                console.log(`[Scriba] 🗑️  File ${fileName} scartato (troppo piccolo: ${stats.size} bytes)`);
                updateRecordingStatus(fileName, 'SKIPPED', null, 'File troppo piccolo');
                try { fs.unlinkSync(filePath); } catch(e) {}
                monitor.logJobProcessed(waitTime, job.attemptsMade);
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

            // console.log(`[Scriba] 🗣️  Inizio trascrizione Whisper: ${fileName}`); // Rimosso per evitare doppio log
            const result = await transcribeWithFallback(transcriptionPath, sessionId, fileName);

            // 🆕 GESTISCI ESPLICITAMENTE GLI ERRORI DI WHISPER
            if (result.error) {
                console.error(`[Scriba] ❌ Errore Whisper per ${fileName}: ${result.error}`);
                updateRecordingStatus(fileName, 'ERROR', null, `Whisper Error: ${result.error}`);
                monitor.logError('Worker', `Whisper failed: ${fileName} - ${result.error}`);
                monitor.logJobFailed();
                throw new Error(result.error);
            }

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
                // console.log(`[Worker] 📝 Ricevuti ${result.segments.length} segmenti word-level da Whisper`); // Rimosso per pulizia
                
                // 🆕 STEP 1: Filtra allucinazioni a livello di parola
                const filteredWords = result.segments
                    .map((s: any) => {
                        const cleanedText = filterWhisperHallucinations(s.text, false);
                        return { ...s, text: cleanedText.trim() };
                    })
                    .filter((s: any) => s.text.length > 0);

                if (filteredWords.length === 0) {
                    updateRecordingStatus(fileName, 'SKIPPED', null, 'Tutte allucinazioni');
                    console.log(`[Worker] 🔇 ${fileName}: tutto filtrato (allucinazioni)`);
                    const isBackedUp = await uploadToOracle(filePath, fileName, sessionId);
                    if (isBackedUp) {
                        try { fs.unlinkSync(filePath); } catch(e) {}
                    }
                    monitor.logJobProcessed(waitTime, job.attemptsMade);
                    return { status: 'skipped', reason: 'all_hallucinations' };
                }
                
                console.log(`[Worker] 🧹 Filtrate ${result.segments.length - filteredWords.length} allucinazioni, ${filteredWords.length} parole rimaste`);

                // 🆕 STEP 2: Raggruppa in frasi leggibili
                const readableSentences = groupWordsIntoSentences(filteredWords);
                
                console.log(`[Worker] 📖 ${filteredWords.length} parole → ${readableSentences.length} frasi`);

                // STEP 3: Salva nel DB (frasi leggibili)
                const readableJson = JSON.stringify(readableSentences);
                updateRecordingStatus(fileName, 'TRANSCRIBED', readableJson);

                // STEP 4: Salva raw per debug
                const wordLevelJson = JSON.stringify(filteredWords);
                saveRawTranscription(fileName, wordLevelJson);

                // Backup e Pulizia Locale
                const isBackedUp = await uploadToOracle(filePath, fileName, sessionId);
                if (isBackedUp) {
                    try {
                        fs.unlinkSync(filePath);
                        // console.log(`[Scriba] 🧹 File locale eliminato dopo backup: ${fileName}`); // Rimosso per pulizia
                        monitor.logFileDeleted();
                    } catch (err) {
                        console.error(`[Scriba] ❌ Errore durante eliminazione locale ${fileName}:`, err);
                    }
                }

                // 4. Decisione: Correzione AI o Bypass?
                if (process.env.ENABLE_AI_TRANSCRIPTION_CORRECTION === 'false') {
                    console.log(`[Scriba] ⏩ Correzione AI disabilitata. Salvo direttamente come PROCESSED.`);

                    // Recuperiamo contesto minimo per salvare metadati coerenti
                    let finalMacro = null;
                    let finalMicro = null;
                    let frozenCharName = null;

                    if (campaignId) {
                        const currentLoc = getCampaignLocationById(campaignId);
                        finalMacro = currentLoc?.macro || null;
                        finalMicro = currentLoc?.micro || null;

                        if (userId) {
                            const profile = getUserProfile(userId, campaignId);
                            frozenCharName = profile.character_name || null;
                        }
                    }

                    updateRecordingStatus(fileName, 'PROCESSED', readableJson, null, finalMacro, finalMicro, [], frozenCharName);
                    monitor.logJobProcessed(waitTime, job.attemptsMade);
                    return { status: 'processed_no_ai', segmentsCount: readableSentences.length };

                } else {
                    // Accodamento per Correzione AI (Standard Flow)
                    // console.log(`[Scriba] 🧠 Accodo ${fileName} per correzione AI...`); // Rimosso per pulizia
                    await correctionQueue.add('correction-job', {
                        sessionId,
                        fileName,
                        segments: readableSentences,
                        campaignId,
                        userId // Passiamo userId per recuperare lo snapshot nel correction worker
                    }, {
                        jobId: `correct-${fileName}-${Date.now()}`,
                        attempts: 3,
                        backoff: { type: 'exponential', delay: 2000 },
                        removeOnComplete: true
                    });

                    monitor.logJobProcessed(waitTime, job.attemptsMade);
                    return { status: 'transcribed', segmentsCount: readableSentences.length };
                }

            } else {
                updateRecordingStatus(fileName, 'SKIPPED', null, 'Silenzio o incomprensibile');
                console.log(`[Scriba] 🔇 Audio ${fileName} scartato (silenzio o incomprensibile)`);

                const isBackedUp = await uploadToOracle(filePath, fileName, sessionId);
                if (isBackedUp) {
                    try { fs.unlinkSync(filePath); } catch(e) {}
                }
                monitor.logJobProcessed(waitTime, job.attemptsMade);
                return { status: 'skipped', reason: 'silence' };
            }

        } catch (e: any) {
            console.error(`[Scriba] ❌ Errore trascrizione ${fileName}: ${e.message}`);
            updateRecordingStatus(fileName, 'ERROR', null, e.message);
            monitor.logError('Worker', `File: ${fileName} - ${e.message}`);
            monitor.logJobFailed();
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
    // 🆕 ARCHITETTURA OTTIMIZZATA: Solo correzione testo
    // L'estrazione metadata (NPCs, locations, monsters) avviene ora in generateSummary()
    // con contesto completo della sessione per qualità superiore e zero duplicazioni
    const correctionWorker = new Worker('correction-processing', async job => {
        const { sessionId, fileName, segments, campaignId, userId } = job.data;
        const startJob = Date.now();
        const waitTime = startJob - job.timestamp;

        try {
            // STEP UNICO: Correzione testuale
            const aiResult = await correctTranscription(segments, campaignId);
            const correctedSegments = aiResult.segments;

            const jsonStr = JSON.stringify(correctedSegments);

            // Recupera luogo corrente della campagna (per tracking, non estrazione)
            let finalMacro = null;
            let finalMicro = null;
            if (campaignId) {
                const current = getCampaignLocationById(campaignId);
                finalMacro = current?.macro || null;
                finalMicro = current?.micro || null;
            }

            // Snapshot identità parlante
            let frozenCharName = null;
            if (userId && campaignId) {
                const profile = getUserProfile(userId, campaignId);
                frozenCharName = profile.character_name || null;
            }

            // Salva il testo corretto - NPCs vuoto perché saranno estratti in summary
            updateRecordingStatus(fileName, 'PROCESSED', jsonStr, null, finalMacro, finalMicro, [], frozenCharName);

            console.log(`[Correttore] ✅ Correzione completata per ${fileName}`);

            monitor.logJobProcessed(waitTime, job.attemptsMade);
            return { status: 'ok', segments: correctedSegments };

        } catch (e: any) {
            console.error(`[Correttore] ❌ Errore correzione ${fileName}: ${e.message}`);
            monitor.logJobFailed();
            throw e;
        }
    }, {
        connection: {
            host: process.env.REDIS_HOST || 'redis',
            port: parseInt(process.env.REDIS_PORT || '6379')
        },
        concurrency: 2 // Più alto perché è I/O bound (chiamate API)
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

// 🆕 FUNZIONE RAGGRUPPA PAROLE IN FRASI
function groupWordsIntoSentences(wordSegments: any[]): any[] {
    if (wordSegments.length === 0) return [];
    
    const PAUSE_THRESHOLD = 2.5; // secondi
    const sentences: any[] = [];
    let currentSentence = {
        start: wordSegments[0].start,
        end: wordSegments[0].end,
        text: wordSegments[0].text.trim()
    };
    
    for (let i = 1; i < wordSegments.length; i++) {
        const pause = wordSegments[i].start - wordSegments[i - 1].end;
        
        if (pause > PAUSE_THRESHOLD) {
            // Nuova frase
            sentences.push(currentSentence);
            currentSentence = {
                start: wordSegments[i].start,
                end: wordSegments[i].end,
                text: wordSegments[i].text.trim()
            };
        } else {
            // Continua frase corrente
            currentSentence.text += ' ' + wordSegments[i].text.trim();
            currentSentence.end = wordSegments[i].end;
        }
    }
    
    if (currentSentence.text) {
        sentences.push(currentSentence);
    }
    
    return sentences;
}
