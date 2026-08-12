/**
 * Workers Entry Point
 */

import { Worker, Job } from 'bullmq';
import { updateRecordingStatus } from '../db';
import { scribaProcessor, unloadTranscriptionModels } from './scriba';
import { correctionProcessor } from './correction';

import { config } from '../config';
import { logger } from '../utils/logger';

const log = logger('Workers');

export * from './scriba';
export * from './correction';
export * from './utils';

export function startWorker() {
    const audioWorker = new Worker('audio-processing', scribaProcessor, {
        connection: {
            host: config.redis.host,
            port: config.redis.port
        },
        concurrency: 1,
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

    log.info('Workers avviati: Scriba (Audio) e Correttore (AI)');

    // Graceful shutdown handler
    const shutdown = async () => {
        log.info('Avvio graceful shutdown dei worker...');
        try {
            await Promise.allSettled([
                audioWorker.close(),
                correctionWorker.close()
            ]);
            log.info('Workers chiusi con successo.');
        } catch (err) {
            log.error('Errore durante shutdown worker', err as Error);
        }
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    return { audioWorker, correctionWorker, shutdown };
}
