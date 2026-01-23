/**
 * Workers Entry Point
 */

import { Worker, Job } from 'bullmq';
import { updateRecordingStatus } from '../db';
import { scribaProcessor, unloadTranscriptionModels } from './scriba';
import { correctionProcessor } from './correction';

export * from './scriba';
export * from './correction';
export * from './utils';

export function startWorker() {
    const audioWorker = new Worker('audio-processing', scribaProcessor, {
        connection: {
            host: process.env.REDIS_HOST || 'redis',
            port: parseInt(process.env.REDIS_PORT || '6379')
        },
        concurrency: 1,
        lockDuration: 27200000, // 2 ORE
        lockRenewTime: 60000,
        maxStalledCount: 0,
    });

    const correctionWorker = new Worker('correction-processing', correctionProcessor, {
        connection: {
            host: process.env.REDIS_HOST || 'redis',
            port: parseInt(process.env.REDIS_PORT || '6379')
        },
        concurrency: 2
    });

    const handleFailure = (workerName: string) => async (job: Job | undefined, err: Error) => {
        const attemptsMade = job?.attemptsMade || 0;
        const maxAttempts = job?.opts.attempts || 1;

        if (attemptsMade >= maxAttempts) {
            console.error(`[${workerName}] 💀 Job ${job?.id} MORTO dopo ${attemptsMade} tentativi: ${err.message}`);

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
