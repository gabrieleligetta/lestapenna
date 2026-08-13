/**
 * Workers Entry Point
 */

import { Worker, Job } from 'bullmq';
import { updateRecordingStatus } from '../db';
import { scribaProcessor, unloadTranscriptionModels } from './scriba';
import { correctionProcessor } from './correction';
import { sessionProcessingProcessor } from '../services/sessionProcessing';

import { config } from '../config';
import { logger } from '../utils/logger';

const log = logger('Workers');

export * from './scriba';
export * from './correction';
export * from './utils';

export function startWorker() {
    const audioConcurrency = Math.max(
        1,
        Number.parseInt(process.env.AUDIO_WORKER_CONCURRENCY || '2', 10) || 2,
    );
    const audioWorker = new Worker('audio-processing', scribaProcessor, {
        connection: {
            host: config.redis.host,
            port: config.redis.port
        },
        // SessionProcessing enqueues one file at a time per session, so this
        // parallelism serves different guilds without flooding one remote PC.
        concurrency: audioConcurrency,
        lockDuration: 7200000, // 2 ore
        lockRenewTime: 30000,  // Renew every 30s, comfortably inside the 2h window
        maxStalledCount: 1,    // Allow one stall recovery before declaring failure
    });

    const correctionWorker = new Worker('correction-processing', correctionProcessor, {
        connection: {
            host: config.redis.host,
            port: config.redis.port
        },
        concurrency: 2
    });

    const sessionWorker = new Worker('session-processing', sessionProcessingProcessor, {
        connection: {
            host: config.redis.host,
            port: config.redis.port
        },
        // Orchestrations may wait on different tables' remote transcription at
        // once. sessionProcessing.ts still serializes the CPU-heavy mix itself.
        concurrency: Math.max(2, Number.parseInt(process.env.SESSION_ORCHESTRATION_CONCURRENCY || '10', 10) || 10),
        // Sessions may sit behind remote transcription for many hours.
        lockDuration: 26 * 60 * 60 * 1000,
        lockRenewTime: 30_000,
        maxStalledCount: 1,
    });

    const handleFailure = (workerName: string) => async (job: Job | undefined, err: Error) => {
        const attemptsMade = job?.attemptsMade || 0;
        const maxAttempts = job?.opts.attempts || 1;

        if (attemptsMade >= maxAttempts) {
            log.error(`[${workerName}] Job ${job?.id} MORTO dopo ${attemptsMade} tentativi`, err);

            if (job?.data?.fileName) {
                try {
                    updateRecordingStatus(job.data.fileName, 'ERROR', null, `Job Failed: ${err.message}`);
                    log.info(`[${workerName}] Stato DB aggiornato a ERROR per ${job.data.fileName}`);
                } catch (dbErr) {
                    log.error(`[${workerName}] Impossibile aggiornare DB per job fallito`, dbErr as Error);
                }
            }
        } else {
            log.warn(`[${workerName}] Job ${job?.id} fallito (tentativo ${attemptsMade}/${maxAttempts}): ${err.message}. Riprovo...`);
        }
    };

    audioWorker.on('failed', handleFailure('Scriba'));
    correctionWorker.on('failed', handleFailure('Correttore'));
    sessionWorker.on('failed', handleFailure('Sessione'));

    log.info(`Workers avviati: Session orchestration (10, mix seriale), Scriba (${audioConcurrency}), Correttore (2)`);

    // Graceful shutdown handler
    const shutdown = async () => {
        log.info('Avvio graceful shutdown dei worker...');
        try {
            await Promise.allSettled([
                audioWorker.close(),
                correctionWorker.close(),
                sessionWorker.close(),
            ]);
            log.info('Workers chiusi con successo.');
        } catch (err) {
            log.error('Errore durante shutdown worker', err as Error);
        }
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    return { audioWorker, correctionWorker, sessionWorker, shutdown };
}
