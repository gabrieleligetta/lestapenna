/**
 * Scriba - Audio Transcription Worker Logic
 */

import { Job } from 'bullmq';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import {
    updateRecordingStatus,
    getUserName,
    getRecording,
    getSessionCampaignId,
    getCampaignLocationById,
    getUserProfile,
    saveRawTranscription
} from '../db';
import {
    convertPcmToWav,
    transcribeLocal,
    unloadLocalModel,
    convertToLocalWav
} from '../services/transcription';
import {
    downloadFromOracle,
    uploadToOracle,
    getPresignedUrl,
    deleteFromOracle
} from '../services/backup';
import { monitor } from '../monitor';
import { correctionQueue } from '../services/queue';
import { filterWhisperHallucinations } from '../utils/filters/whisper';
import { groupWordsIntoSentences } from './utils';
import { sessionPhaseManager } from '../services/SessionPhaseManager';

import { config } from '../config';

// --- CONFIGURAZIONE PC REMOTO ---
const REMOTE_WHISPER_URL = config.remoteWhisper.url;
const REMOTE_TIMEOUT = 2700000; // 45 minuti

// --- HELPER FUNCTIONS EXPORT ---

export async function notifyRemoteModelUnload(): Promise<void> {
    if (REMOTE_WHISPER_URL) {
        try {
            console.log('[Scriba] 🧹 Invio segnale di unload modello al PC remoto...');
            const unloadUrl = `${REMOTE_WHISPER_URL}/unload`;
            const response = await axios.post(unloadUrl, { unload: true }, { timeout: 10000 });

            if (response.data && response.data.status === 'unloaded') {
                console.log('[Scriba] ✅ Segnale unload confermato dal remoto.');
            } else {
                console.warn('[Scriba] ⚠️ Risposta inattesa dal remoto per unload:', response.data);
            }
        } catch (e: any) {
            console.warn(`[Scriba] ⚠️ Impossibile inviare segnale unload: ${e.message}`);
        }
    }
}

export async function unloadTranscriptionModels(): Promise<void> {
    const tasks: Promise<void>[] = [];

    if (REMOTE_WHISPER_URL) {
        tasks.push(notifyRemoteModelUnload());
    }

    // Unload local AS WELL to ensure we are not holding memory anywhere
    tasks.push(unloadLocalModel());

    await Promise.allSettled(tasks);
}

async function transcribeWithFallback(
    localPath: string,
    sessionId: string,
    fileName: string
): Promise<any> {
    const isFlac = fileName.toLowerCase().endsWith('.flac');
    let tempKey: string | null = null;

    // 🔥 TENTATIVO 1: PC Remoto via Tailscale
    if (REMOTE_WHISPER_URL) {
        try {
            let presignedUrl: string | null = null;

            if (isFlac) {
                console.log('[Scriba] 📡 Uploading FLAC for High-Fidelity Remote Transcription...');
                tempKey = `transcription_temp/${path.basename(localPath)}`;
                await uploadToOracle(localPath, path.basename(localPath), undefined, tempKey);

                console.log('[Scriba] 🔗 Generazione presigned URL per FLAC...');
                presignedUrl = await getPresignedUrl(tempKey, undefined, 3600);
            } else {
                console.log('[Scriba] 🔗 Generazione presigned URL per PC remoto...');
                presignedUrl = await getPresignedUrl(fileName, sessionId, 3600);
            }

            if (!presignedUrl) {
                console.warn('[Scriba] ⚠️ Impossibile generare presigned URL, uso fallback locale');
            } else {
                console.log('[Scriba] 🌐 Tentativo PC remoto...');
                const startRemote = Date.now();
                const transcribeUrl = `${REMOTE_WHISPER_URL}/transcribe`;

                const response = await axios.post(
                    transcribeUrl,
                    { fileUrl: presignedUrl },
                    {
                        timeout: REMOTE_TIMEOUT,
                        headers: { 'Content-Type': 'application/json' }
                    }
                );

                if (response.data && !response.data.error) {
                    const elapsed = ((Date.now() - startRemote) / 1000).toFixed(1);
                    console.log(`[Scriba] ✅ PC remoto completato in ${elapsed}s`);

                    if (tempKey) deleteFromOracle(path.basename(localPath), undefined).catch(e => console.error("Temp FLAC delete failed", e));
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
        } finally {
            if (tempKey) deleteFromOracle(path.basename(localPath), undefined).catch(e => console.error("Temp FLAC delete failed", e));
        }
    }

    // 🔄 FALLBACK: Whisper Locale
    console.log('[Scriba] 💻 Uso Whisper locale (server)...');

    let localWavPath = localPath;
    if (isFlac) {
        console.log('[Scriba] 🖥️ Converting FLAC to WAV for Local Whisper...');
        localWavPath = await convertToLocalWav(localPath);
    }

    try {
        const result = await transcribeLocal(localWavPath);
        if (isFlac && localWavPath !== localPath && fs.existsSync(localWavPath)) {
            fs.unlinkSync(localWavPath);
        }
        return result;
    } catch (e) {
        if (isFlac && localWavPath !== localPath && fs.existsSync(localWavPath)) {
            fs.unlinkSync(localWavPath);
        }
        throw e;
    }
}

// --- PROCESSOR ---

export const scribaProcessor = async (job: Job) => {
    const { sessionId, fileName, filePath, userId } = job.data;

    const campaignId = getSessionCampaignId(sessionId);
    // const userName = (campaignId ? getUserName(userId, campaignId) : null) || userId; // Unused
    const startJob = Date.now();
    const waitTime = startJob - job.timestamp;

    // Idempotenza & Recupero "Buco Nero"
    const currentRecording = getRecording(fileName);

    if (currentRecording) {
        if (currentRecording.status === 'PROCESSED' || currentRecording.status === 'SKIPPED') {
            console.log(`[Scriba] ⏩ File ${fileName} già elaborato (stato: ${currentRecording.status}). Salto.`);
            monitor.logJobProcessed(waitTime, job.attemptsMade);
            return { status: 'already_done', reason: currentRecording.status };
        }

        if (currentRecording.status === 'TRANSCRIBED') {
            console.log(`[Scriba] ⚠️ File ${fileName} trovato in stato TRANSCRIBED. Tento recupero verso coda correzione...`);
            try {
                const segments = JSON.parse(currentRecording.transcription_text || '[]');
                if (segments.length > 0) {
                    // ... (handled via multiple chunks)
                    await correctionQueue.add('correction-job', {
                        sessionId,
                        fileName,
                        segments: segments,
                        campaignId,
                        userId
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
                    console.log(`[Scriba] ⚠️ Correzione disabilitata, ma file in limbo. Procedo con logica standard.`);
                }
            } catch (e) {
                console.error(`[Scriba] ❌ Errore recupero JSON per ${fileName}, procedo con ritrascrizione.`);
            }
        }
    }

    console.log(`[Scriba] 🗣️  Inizio trascrizione: ${fileName}`);
    updateRecordingStatus(fileName, 'PROCESSING');

    // Set session phase to TRANSCRIBING (only if not already further along)
    const currentPhase = sessionPhaseManager.getPhase(sessionId);
    if (!currentPhase || currentPhase.phase === 'RECORDING' || currentPhase.phase === 'IDLE') {
        sessionPhaseManager.setPhase(sessionId, 'TRANSCRIBING');
    }

    try {
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
            try { fs.unlinkSync(filePath); } catch (e) { }
            monitor.logJobProcessed(waitTime, job.attemptsMade);
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

        const result = await transcribeWithFallback(transcriptionPath, sessionId, fileName);

        if (result.error) {
            console.error(`[Scriba] ❌ Errore Whisper per ${fileName}: ${result.error}`);
            updateRecordingStatus(fileName, 'ERROR', null, `Whisper Error: ${result.error}`);
            monitor.logError('Worker', `Whisper failed: ${fileName} - ${result.error}`);
            monitor.logJobFailed();
            throw new Error(result.error);
        }

        // Cleanup: remove original file and temp WAV (if PCM conversion created one)
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (err) {
                console.error(`[Scriba] ❌ Errore eliminazione originale ${fileName}:`, err);
            }
        }
        if (isPcm && transcriptionPath !== filePath && fs.existsSync(transcriptionPath)) {
            try { fs.unlinkSync(transcriptionPath); } catch {}
        }

        let audioDuration = 0;
        if (result.segments && result.segments.length > 0) {
            audioDuration = result.segments[result.segments.length - 1].end;
        }

        const processingTime = Date.now() - startJob;
        monitor.logFileProcessed(audioDuration, processingTime);

        if (result.segments && result.segments.length > 0) {
            const filteredWords = result.segments
                .map((s: any) => {
                    const cleanedText = filterWhisperHallucinations(s.text, false);
                    return { ...s, text: cleanedText.trim() };
                })
                .filter((s: any) => s.text.length > 0);

            if (filteredWords.length === 0) {
                updateRecordingStatus(fileName, 'SKIPPED', null, 'Tutte allucinazioni');
                console.log(`[Worker] 🔇 ${fileName}: tutto filtrato (allucinazioni)`);
                if (fs.existsSync(filePath)) {
                    try { fs.unlinkSync(filePath); } catch (e) { }
                }
                monitor.logJobProcessed(waitTime, job.attemptsMade);
                return { status: 'skipped', reason: 'all_hallucinations' };
            }

            console.log(`[Worker] 🧹 Filtrate ${result.segments.length - filteredWords.length} allucinazioni, ${filteredWords.length} parole rimaste`);

            const readableSentences = groupWordsIntoSentences(filteredWords);

            console.log(`[Worker] 📖 ${filteredWords.length} parole → ${readableSentences.length} frasi`);

            const readableJson = JSON.stringify(readableSentences);
            updateRecordingStatus(fileName, 'TRANSCRIBED', readableJson);

            const wordLevelJson = JSON.stringify(filteredWords);
            saveRawTranscription(fileName, wordLevelJson);

            if (!config.features.enableAiCorrection) {
                console.log(`[Scriba] ⏩ Correzione AI disabilitata. Salvo direttamente come PROCESSED.`);

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
                await correctionQueue.add('correction-job', {
                    sessionId,
                    fileName,
                    segments: readableSentences,
                    campaignId,
                    userId
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

            if (fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (e) { }
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
};
