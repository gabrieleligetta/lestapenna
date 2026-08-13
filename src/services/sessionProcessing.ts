import { Job } from 'bullmq';
import { getSessionRecordings } from '../db';
import { runWithSessionScope } from '../bard/ai/scope';
import { logger } from '../utils/logger';
import { monitor } from '../monitor';
import type { SessionMetrics } from '../monitor/types';
import { mixSessionAudio } from './sessionMixer';
import { audioQueue, sessionFinalizationQueue, sessionProcessingQueue } from './queue';
import { sessionPhaseManager } from './SessionPhaseManager';

const log = logger('SessionProcessing');
const TERMINAL_RECORDING_STATUSES = new Set(['PROCESSED', 'SKIPPED', 'ERROR']);
const COMPLETION_POLL_MS = Number.parseInt(process.env.SESSION_COMPLETION_POLL_MS || '10000', 10) || 10_000;
const RECORDING_COMPLETION_POLL_MS = 1_000;
const COMPLETION_TIMEOUT_MS = Number.parseInt(process.env.SESSION_COMPLETION_TIMEOUT_MS || '86400000', 10) || 86_400_000;
let mixTail: Promise<void> = Promise.resolve();

async function withSerializedMix<T>(work: () => Promise<T>): Promise<T> {
    const previous = mixTail;
    let release!: () => void;
    mixTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
        return await work();
    } finally {
        release();
    }
}

export interface SessionProcessingJobData {
    sessionId: string;
    guildId: string;
    /** Discord channel where progress/final output should be posted, when still accessible. */
    channelId?: string;
}

export interface SessionFinalizationJobData extends SessionProcessingJobData {
    /** Partial metrics collected in the isolated worker, continued by gateway. */
    metrics?: SessionMetrics;
}

async function replaceTerminalJob(queue: any, jobId: string): Promise<boolean> {
    if (typeof queue.getJob !== 'function') return true;
    const existing = await queue.getJob(jobId);
    if (!existing) return true;
    const state = await existing.getState();
    if (['waiting', 'delayed', 'active', 'waiting-children', 'prioritized'].includes(state)) {
        return false;
    }
    // BullMQ keeps completed jobs for diagnostics and failed jobs forever.
    // A boot recovery with the same deterministic ID would otherwise return
    // that inert job without ever running it again.
    await existing.remove();
    return true;
}

/**
 * Durable hand-off from the voice gateway to the processing container.
 *
 * No automatic retry is configured for this orchestration job: the child audio
 * jobs already have bounded retries, while replaying an entire session could
 * repeat paid AI calls. Recovery/reset explicitly removes and recreates it.
 */
export async function enqueueSessionProcessing(
    sessionId: string,
    guildId: string,
    channelId?: string,
): Promise<void> {
    const jobId = `session-${sessionId}`;
    if (!await replaceTerminalJob(sessionProcessingQueue, jobId)) return;
    await sessionProcessingQueue.add(
        'process-session',
        { sessionId, guildId, channelId } satisfies SessionProcessingJobData,
        {
            jobId,
            attempts: 1,
            removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
            removeOnFail: false,
        },
    );
}

export async function enqueueSessionFinalization(
    sessionId: string,
    guildId: string,
    channelId?: string,
    metrics?: SessionMetrics | null,
): Promise<void> {
    const jobId = `finalize-${sessionId}`;
    if (!await replaceTerminalJob(sessionFinalizationQueue, jobId)) return;
    await sessionFinalizationQueue.add(
        'finalize-session',
        { sessionId, guildId, channelId, ...(metrics ? { metrics } : {}) } satisfies SessionFinalizationJobData,
        {
            jobId,
            attempts: 1,
            removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
            removeOnFail: false,
        },
    );
}

/** Fire-and-forget boundary retained for command/timer callers. */
export function launchSessionProcessing(sessionId: string, guildId: string, channelId?: string): void {
    void enqueueSessionProcessing(sessionId, guildId, channelId).catch((error) => {
        log.error(`Accodamento processing fallito per la sessione ${sessionId}`, error as Error);
        try {
            sessionPhaseManager.markFailed(sessionId, `Queue hand-off: ${(error as Error).message}`);
        } catch (markError) {
            log.error(`Impossibile marcare ERROR la sessione ${sessionId}`, markError as Error);
        }
    });
}

async function waitForRecordings(sessionId: string): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
        const recordings = getSessionRecordings(sessionId);
        if (recordings.length > 0 && recordings.every(recording => TERMINAL_RECORDING_STATUSES.has(recording.status))) {
            return;
        }
        if (Date.now() - startedAt >= COMPLETION_TIMEOUT_MS) {
            throw new Error(`Timeout processing sessione dopo ${Math.round(COMPLETION_TIMEOUT_MS / 3600000)}h`);
        }
        await new Promise(resolve => setTimeout(resolve, COMPLETION_POLL_MS));
    }
}

async function waitForRecording(sessionId: string, fileName: string): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
        const recording = getSessionRecordings(sessionId).find(row => row.filename === fileName);
        if (!recording || TERMINAL_RECORDING_STATUSES.has(recording.status)) return;
        if (Date.now() - startedAt >= COMPLETION_TIMEOUT_MS) {
            throw new Error(`Timeout processing file ${fileName} dopo ${Math.round(COMPLETION_TIMEOUT_MS / 3600000)}h`);
        }
        await new Promise(resolve => setTimeout(resolve, RECORDING_COMPLETION_POLL_MS));
    }
}

async function runSessionProcessing(job: Job<SessionProcessingJobData>): Promise<{ queued: number }> {
    const { sessionId, guildId, channelId } = job.data;
    monitor.startSession(sessionId);
    monitor.setRuntimePhase(sessionId, 'processing');
    log.info('Avvio mix e trascrizione sul worker isolato', { guildId, sessionId });

    try {
        const initial = getSessionRecordings(sessionId);
        if (initial.length === 0) throw new Error('Nessuna registrazione trovata');

        // The master is an archive artifact and mixing is deliberately serialized
        // by this Worker's concurrency=1. It may use several ffmpeg children
        // internally, but never competes with another session mix.
        await withSerializedMix(() => mixSessionAudio(sessionId, true));

        let queued = 0;
        for (const recording of getSessionRecordings(sessionId)) {
            if (recording.status !== 'PENDING' && recording.status !== 'SECURED' && recording.status !== 'QUEUED') continue;
            await audioQueue.add('transcribe-job', {
                sessionId: recording.session_id,
                fileName: recording.filename,
                filePath: recording.filepath,
                userId: recording.user_id,
            }, {
                jobId: recording.filename,
                attempts: 5,
                backoff: { type: 'exponential', delay: 2000 },
                removeOnComplete: true,
                removeOnFail: false,
            });
            queued++;
            // One in-flight transcription per session keeps a table's own PC
            // stable. Different session orchestration jobs still advance in
            // parallel through the audio Worker's bounded concurrency.
            await waitForRecording(sessionId, recording.filename);
        }

        // Covers recordings already TRANSCRIBED when a recovery job starts and
        // waits for their correction without charging for transcription again.
        await waitForRecordings(sessionId);

        const workerMetrics = monitor.snapshotSession(sessionId);
        await enqueueSessionFinalization(sessionId, guildId, channelId, workerMetrics);
        monitor.discardSession(sessionId);

        log.info(`Sessione pronta per la finalizzazione (${queued} file accodati)`, { guildId, sessionId });
        return { queued };
    } catch (error) {
        sessionPhaseManager.markFailed(sessionId, `Processing worker: ${(error as Error).message}`);
        await monitor.endSession();
        throw error;
    }
}

export const sessionProcessingProcessor = (job: Job<SessionProcessingJobData>) =>
    runWithSessionScope(job.data.sessionId, () => runSessionProcessing(job));
