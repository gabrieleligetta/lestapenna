/**
 * Scriba - Audio Transcription Worker Logic
 */

import { Job } from 'bullmq';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import {
    updateRecordingStatus,
    getRecording,
    getSessionCampaignId,
    saveRawTranscription
} from '../db';
import { resolveRecordingContext, enqueueCorrection } from './shared';
import { convertPcmToWav } from '../services/audioConvert';
import {
    downloadFromOracle,
    uploadToOracle,
    getPresignedUrl,
    deleteFromOracle
} from '../services/backup';
import { monitor } from '../monitor';
import { filterWhisperHallucinations } from '../utils/filters/whisper';
import { groupWordsIntoSentences } from './utils';
import { sessionPhaseManager } from '../services/SessionPhaseManager';

import { config } from '../config';
import { wakeAndWait } from '../services/wake';
import { isFinalAttempt } from './retryState';
import { logger } from '../utils/logger';
import { aiLanguageName, getCampaignLocale, whisperLanguage, type Locale } from '../i18n';
import { transcribeWithGemini } from '../bard/geminiNativeTranscribe';
import { runWithSessionScope } from '../bard/ai/scope';
import { currentAiScope, requireAiScope } from '../bard/ai/ambientScope';
import {
    resolveTranscription,
    type ResolvedCloudTranscription,
    type ResolvedRemoteTranscription,
} from '../bard/ai/transcription';
import { createProviderClient } from '../bard/ai/providerFactory';
import { classifyProviderError, redactKeyLike } from '../bard/ai/providerErrors';
import { SPEECH_TO_TEXT_PHASE } from '../services/sessionCostEstimator';
import { flagCredential } from '../bard/ai/credentials';
import type { AiScope } from '../bard/ai/types';

const log = logger('Scriba');

/**
 * Lifetime of the download link handed to the table's transcription PC.
 *
 * The audio is not sent in the request body: it is uploaded to the bucket and
 * the remote machine is given a presigned URL to fetch it. That URL grants
 * **unauthenticated** access to a raw voice recording to anyone holding it, so
 * its lifetime is the window in which a leaked link is still useful — and it
 * used to be a full hour for a download that starts immediately.
 *
 * Ten minutes leaves room for a slow link and a machine still waking up from
 * Wake-on-LAN, and cuts the exposure by a factor of six.
 */
const PRESIGNED_URL_TTL_SECONDS = 600;

// --- HELPER FUNCTIONS EXPORT ---

/**
 * Asks the table's PC to free its VRAM.
 *
 * Without a scope it reaches **nobody**: this function used to talk to the one
 * PC configured in the environment, and on an instance with several tables it
 * would have unloaded the model from someone else's computer.
 */
export async function notifyRemoteModelUnload(scope?: AiScope): Promise<void> {
    const resolved = resolveTranscription(scope ?? currentAiScope() ?? { guildId: '' });
    if (resolved.engine !== 'remote') return;

    try {
        log.info('Invio segnale di unload modello al PC del tavolo...');
        const response = await axios.post(
            `${resolved.remote.url}/unload`,
            { unload: true },
            { timeout: 10000, headers: resolved.remote.authHeaders },
        );
        if (response.data?.status !== 'unloaded') log.warn('Risposta inattesa dal remoto per unload');
    } catch (e: any) {
        log.warn(`Impossibile inviare segnale unload: ${e.message}`);
    }
}

export async function unloadTranscriptionModels(scope?: AiScope): Promise<void> {
    await Promise.allSettled([notifyRemoteModelUnload(scope)]);
}

/**
 * Is the table's PC answering? If it is off and has Wake-on-LAN configured,
 * switch it on and wait for it to come back up.
 */
type RemoteHealthResult =
    | { reachable: true }
    | { reachable: false; reason: string };

async function checkRemoteHealth(remote: ResolvedRemoteTranscription): Promise<RemoteHealthResult> {
    try {
        await axios.get(`${remote.url}/health`, { timeout: remote.connectTimeoutMs });
        return { reachable: true };
    } catch {
        // Wake-up only starts if the table configured a MAC: without one there is
        // nothing to wake, and insisting only lengthens the wait.
        if (!remote.wake.macAddress) {
            return {
                reachable: false,
                reason: 'PC del tavolo offline e Wake-on-LAN non configurato per questa gilda',
            };
        }

        log.info('PC del tavolo offline — tentativo di accensione remota...');
        const result = await wakeAndWait({
            macAddress: remote.wake.macAddress,
            method: remote.wake.method,
            options: remote.wake.options,
            secrets: remote.wake.secrets,
            healthUrl: `${remote.url}/health`,
            healthHeaders: remote.authHeaders,
            bootTimeoutMs: remote.wake.bootTimeoutMs,
            pollIntervalMs: remote.wake.pollIntervalMs,
        });
        if (result.success) return { reachable: true };
        if (result.reason === 'boot_timeout') {
            return {
                reachable: false,
                reason: `PC del tavolo non online entro ${Math.round(remote.wake.bootTimeoutMs / 1000)}s dopo il Wake-on-LAN`,
            };
        }
        if (result.reason.startsWith('unknown_wake_method:')) {
            return { reachable: false, reason: 'metodo Wake-on-LAN non riconosciuto' };
        }
        return { reachable: false, reason: 'richiesta di accensione remota fallita' };
    }
}

/**
 * Transcribes on the table's PC.
 *
 * The file does not travel inside the request: a presigned URL is generated and
 * the PC downloads it itself. If it does not answer, the error propagates — the
 * audio stays saved and the session can be reprocessed.
 */
async function transcribeRemote(
    remote: ResolvedRemoteTranscription,
    localPath: string,
    sessionId: string,
    fileName: string,
    language: string,
): Promise<any> {
    const isFlac = fileName.toLowerCase().endsWith('.flac');
    let tempKey: string | null = null;

    // Health check before the upload: avoids pushing a file to Oracle that
    // nobody will download.
    const health = await checkRemoteHealth(remote);
    if (!health.reachable) {
        throw new Error(`TRANSCRIPTION_UNAVAILABLE: ${health.reason}`);
    }

    try {
        let presignedUrl: string | null;

        if (isFlac) {
            log.info('Uploading FLAC for High-Fidelity Remote Transcription...');
            tempKey = `transcription_temp/${path.basename(localPath)}`;
            await uploadToOracle(localPath, path.basename(localPath), undefined, tempKey);
            presignedUrl = await getPresignedUrl(tempKey, undefined, PRESIGNED_URL_TTL_SECONDS);
        } else {
            presignedUrl = await getPresignedUrl(fileName, sessionId, PRESIGNED_URL_TTL_SECONDS);
        }

        if (!presignedUrl) {
            throw new Error('TRANSCRIPTION_UNAVAILABLE: impossibile generare la presigned URL');
        }

        const startRemote = Date.now();
        const response = await axios.post(
            `${remote.url}/transcribe`,
            // `model` omitted when the table did not choose one: the PC then
            // uses whatever its own WHISPER_MODEL says, which is what every
            // existing install already does.
            { fileUrl: presignedUrl, language, ...(remote.model ? { model: remote.model } : {}) },
            {
                timeout: remote.timeoutMs,
                headers: { 'Content-Type': 'application/json', ...remote.authHeaders },
            },
        );

        if (response.data && !response.data.error) {
            log.info(`PC del tavolo completato in ${((Date.now() - startRemote) / 1000).toFixed(1)}s`);
            return response.data;
        }
        throw new Error(response.data?.error || 'Remote returned error');

    } catch (error: any) {
        const isTimeout = error.code === 'ECONNABORTED' || error.message?.includes('timeout');
        const isNetworkError = ['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH'].includes(error.code);

        if (isTimeout) {
            throw new Error(`TRANSCRIPTION_UNAVAILABLE: timeout PC del tavolo dopo ${remote.timeoutMs / 1000}s`);
        }
        if (isNetworkError) {
            throw new Error('TRANSCRIPTION_UNAVAILABLE: PC del tavolo non raggiungibile (rete)');
        }
        throw error;
    } finally {
        if (tempKey) deleteFromOracle(tempKey, sessionId).catch(e => log.error('Temp FLAC delete failed', {}, e));
    }
}

/**
 * Transcribes with a cloud model, on the table's own key.
 *
 * **The whole file is uploaded.** That is the difference from the table's PC,
 * which — being our own software — accepts a presigned URL and downloads the
 * file itself: no cloud provider offers the same, so here the audio goes
 * through the bot.
 *
 * Two paths, for two different ways of understanding transcription — and the
 * table picks between them based on which key it already holds.
 */
async function transcribeCloud(
    cloud: ResolvedCloudTranscription,
    localPath: string,
    language: string,
    locale: Locale,
): Promise<any> {
    const startCloud = Date.now();

    try {
        const result = cloud.provider === 'gemini'
            ? await transcribeCloudGemini(cloud, localPath, locale)
            : await transcribeCloudOpenAi(cloud, localPath, language);

        log.info(`Trascrizione cloud completata in ${((Date.now() - startCloud) / 1000).toFixed(1)}s`);
        return result;

    } catch (error) {
        const classified = classifyProviderError(cloud.provider, error);
        if (classified.kind === 'QUOTA_EXHAUSTED' || classified.kind === 'AUTH_FAILED') {
            flagCredential(cloud.creds, classified.kind, redactKeyLike(classified.raw));
            throw new Error(`TRANSCRIPTION_UNAVAILABLE: ${classified.kind}`);
        }
        throw error;
    }
}

/** Endpoint dedicato: timestamp in secondi frazionari, la resa migliore. */
async function transcribeCloudOpenAi(
    cloud: ResolvedCloudTranscription,
    localPath: string,
    language: string,
): Promise<any> {
    const client = createProviderClient(cloud.creds);
    const response: any = await client.audio.transcriptions.create({
        file: fs.createReadStream(localPath) as any,
        model: cloud.model,
        language,
        // The pipeline works on timed segments: flat text would lose who spoke
        // and when, which is half the value of the transcription of a
        // session.
        response_format: 'verbose_json',
    });

    const segments = (response.segments ?? []).map((segment: any) => ({
        start: segment.start,
        end: segment.end,
        text: segment.text,
    }));

    // No segments but some text: better one untimed line than throwing the
    // transcription away.
    if (segments.length === 0 && response.text) {
        return { segments: [{ start: 0, end: response.duration ?? 0, text: response.text }] };
    }
    return { segments };
}

/**
 * A general-purpose model with structured output.
 *
 * It exists so that a table on Gemini can use **one key for the whole flow**
 * instead of opening an OpenAI account just for transcription. It also costs
 * less — audio is worth 32 tokens per second — at the price of per-second
 * rather than fractional timestamps.
 */
async function transcribeCloudGemini(
    cloud: ResolvedCloudTranscription,
    localPath: string,
    locale: Locale,
): Promise<any> {
    // The language name spelled out, not the ISO code: here we are talking to a
    // general-purpose model in natural language, not to an endpoint.
    const result = await transcribeWithGemini(
        cloud.creds, localPath, cloud.model, aiLanguageName(locale),
    );

    // `speechToText`, not `transcription`: that name belongs to the phase that
    // *corrects* the transcript, which logs here too. Sharing one bucket made
    // the per-phase calibration average audio tokens together with correction
    // tokens — two quantities with nothing to do with each other.
    monitor.logAIRequestWithCost(
        SPEECH_TO_TEXT_PHASE, 'gemini', cloud.model,
        result.usage.input, result.usage.output, 0, 0, false,
    );
    return { segments: result.segments };
}

/**
 * Transcribes with whichever engine the table chose.
 *
 * **The two paths never cross.** Falling back from a switched-off PC to the
 * cloud would spend money nobody authorized, over a fault that is often solved
 * by turning a computer on.
 */
async function transcribe(
    localPath: string,
    sessionId: string,
    fileName: string,
    language: string,
    locale: Locale,
): Promise<any> {
    const resolved = resolveTranscription(requireAiScope());

    if (resolved.engine === 'remote') {
        return transcribeRemote(resolved.remote, localPath, sessionId, fileName, language);
    }
    if (resolved.engine === 'cloud') {
        return transcribeCloud(resolved.cloud, localPath, language, locale);
    }
    throw new Error(
        `TRANSCRIPTION_NOT_CONFIGURED: questo tavolo non ha un motore di trascrizione (${resolved.reason})`,
    );
}

// --- PROCESSOR ---

const runScribaJob = async (job: Job) => {
    const { sessionId, fileName, filePath, userId } = job.data;

    const campaignId = getSessionCampaignId(sessionId);
    const startJob = Date.now();
    const waitTime = startJob - job.timestamp;

    // Idempotenza & Recupero "Buco Nero"
    const currentRecording = getRecording(fileName);

    if (currentRecording) {
        if (currentRecording.status === 'PROCESSED' || currentRecording.status === 'SKIPPED') {
            log.info(`File ${fileName} già elaborato (stato: ${currentRecording.status}). Salto.`, { sessionId });
            monitor.logJobProcessed(waitTime, job.attemptsMade);
            return { status: 'already_done', reason: currentRecording.status };
        }

        if (currentRecording.status === 'TRANSCRIBED') {
            log.warn(`File ${fileName} trovato in stato TRANSCRIBED. Tento recupero verso coda correzione...`, { sessionId });
            try {
                const segments = JSON.parse(currentRecording.transcription_text || '[]');
                if (segments.length > 0) {
                    await enqueueCorrection({ sessionId, fileName, segments, campaignId, userId });
                    log.info(`Recupero riuscito: ${fileName} ri-accodato per correzione.`, { sessionId });
                    monitor.logJobProcessed(waitTime, job.attemptsMade);
                    return { status: 'recovered_to_correction' };
                } else {
                    log.warn('Correzione disabilitata, ma file in limbo. Procedo con logica standard.', { sessionId });
                }
            } catch (e) {
                log.error(`Errore recupero JSON per ${fileName}, procedo con ritrascrizione.`, { sessionId });
            }
        }
    }

    log.info(`Inizio trascrizione: ${fileName}`, { sessionId });
    updateRecordingStatus(fileName, 'PROCESSING');

    // Set session phase to TRANSCRIBING (only if not already further along)
    const currentPhase = sessionPhaseManager.getPhase(sessionId);
    if (!currentPhase || currentPhase.phase === 'RECORDING' || currentPhase.phase === 'IDLE') {
        sessionPhaseManager.setPhase(sessionId, 'TRANSCRIBING');
    }

    try {
        if (!fs.existsSync(filePath)) {
            log.warn(`File non trovato localmente: ${fileName}. Tento ripristino dal Cloud...`, { sessionId });
            const success = await downloadFromOracle(fileName, filePath, sessionId);
            if (!success) {
                log.error(`File non trovato nemmeno su Oracle: ${fileName}`, { sessionId });
                updateRecordingStatus(fileName, 'ERROR', null, 'File non trovato su disco né su Cloud');
                monitor.logError('Worker', `File non trovato: ${fileName}`);
                monitor.logJobFailed();
                return { status: 'failed', reason: 'file_not_found' };
            }
        }

        const stats = fs.statSync(filePath);
        if (stats.size < 5000) {
            log.info(`File ${fileName} scartato (troppo piccolo: ${stats.size} bytes)`, { sessionId });
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
            log.info(`Conversione in WAV (Legacy PCM): ${fileName}`, { sessionId });
            await convertPcmToWav(filePath, wavPath);
            transcriptionPath = wavPath;
        }

        // Transcription language = the campaign's language (guild config, default it/en)
        const locale = campaignId ? getCampaignLocale(campaignId) : 'it';
        const language = whisperLanguage(locale);
        const result = await transcribe(transcriptionPath, sessionId, fileName, language, locale);

        if (result.error) {
            log.error(`Errore Whisper per ${fileName}: ${result.error}`, { sessionId });
            throw new Error(result.error);
        }

        // Cleanup: remove original file and temp WAV (if PCM conversion created one)
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (err) {
                log.error(`Errore eliminazione originale ${fileName}`, { sessionId }, err as Error);
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
                log.info(`${fileName}: tutto filtrato (allucinazioni)`, { sessionId });
                if (fs.existsSync(filePath)) {
                    try { fs.unlinkSync(filePath); } catch (e) { }
                }
                monitor.logJobProcessed(waitTime, job.attemptsMade);
                return { status: 'skipped', reason: 'all_hallucinations' };
            }

            log.info(`Filtrate ${result.segments.length - filteredWords.length} allucinazioni, ${filteredWords.length} parole rimaste`, { sessionId });

            const readableSentences = groupWordsIntoSentences(filteredWords);

            log.info(`${filteredWords.length} parole -> ${readableSentences.length} frasi`, { sessionId });

            const readableJson = JSON.stringify(readableSentences);
            updateRecordingStatus(fileName, 'TRANSCRIBED', readableJson);

            const wordLevelJson = JSON.stringify(filteredWords);
            saveRawTranscription(fileName, wordLevelJson);

            if (!config.features.enableAiCorrection) {
                log.info('Correzione AI disabilitata. Salvo direttamente come PROCESSED.', { sessionId });

                const { finalMacro, finalMicro, frozenCharName } = resolveRecordingContext(campaignId, userId);

                updateRecordingStatus(fileName, 'PROCESSED', readableJson, null, finalMacro, finalMicro, [], frozenCharName);
                monitor.logJobProcessed(waitTime, job.attemptsMade);
                return { status: 'processed_no_ai', segmentsCount: readableSentences.length };

            } else {
                await enqueueCorrection({ sessionId, fileName, segments: readableSentences, campaignId, userId });

                monitor.logJobProcessed(waitTime, job.attemptsMade);
                return { status: 'transcribed', segmentsCount: readableSentences.length };
            }

        } else {
            updateRecordingStatus(fileName, 'SKIPPED', null, 'Silenzio o incomprensibile');
            log.info(`Audio ${fileName} scartato (silenzio o incomprensibile)`, { sessionId });

            if (fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (e) { }
            }
            monitor.logJobProcessed(waitTime, job.attemptsMade);
            return { status: 'skipped', reason: 'silence' };
        }

    } catch (e: any) {
        log.error(`Errore trascrizione ${fileName}: ${e.message}`, { sessionId });
        const configuredAttempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
        if (isFinalAttempt(job.attemptsMade, configuredAttempts)) {
            updateRecordingStatus(fileName, 'ERROR', null, e.message);
            monitor.logError('Worker', `File: ${fileName} - ${e.message}`);
            monitor.logJobFailed();
        } else {
            // The orchestration worker treats ERROR as terminal. Keeping a
            // retryable failure in QUEUED prevents a premature report while
            // BullMQ is waiting to run the next attempt.
            updateRecordingStatus(
                fileName,
                'QUEUED',
                null,
                `Tentativo ${job.attemptsMade + 1}/${configuredAttempts} fallito: ${e.message}`,
            );
            log.warn(
                `Trascrizione ${fileName} ritentabile (${job.attemptsMade + 1}/${configuredAttempts})`,
                { sessionId },
            );
        }
        throw e;
    }
};

/**
 * The job restarts in a fresh async context, on the far side of Redis:
 * the table's scope has to be rebuilt here, or the AI correction would end up
 * on somebody else's keys.
 */
export const scribaProcessor = (job: Job) =>
    runWithSessionScope(job.data.sessionId, () => runScribaJob(job));
