import { Queue } from 'bullmq';

import { config } from '../config';

function createDisabledQueue(name: string): any {
    return {
        name,
        async pause() { /* disabled in local harness */ },
        async resume() { /* disabled in local harness */ },
        async getJobs() { return []; }
    };
}

// Configurazione Redis
const connection = {
    host: config.redis.host,
    port: config.redis.port
};

// Coda Audio (Trascrizione)
export const audioQueue = process.env.DISABLE_REDIS === 'true'
    ? createDisabledQueue('audio-processing')
    : new Queue('audio-processing', { connection });

// Coda Correzione (AI Post-Processing)
export const correctionQueue = process.env.DISABLE_REDIS === 'true'
    ? createDisabledQueue('correction-processing')
    : new Queue('correction-processing', { connection });

/**
 * Removes ALL the jobs (active ones included) belonging to a given session from both queues.
 */
export async function removeSessionJobs(sessionId: string) {
    let removedCount = 0;

    const queues = [audioQueue, correctionQueue];

    for (const queue of queues) {
        // Fetch every job in any state
        const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'failed', 'completed']);

        for (const job of jobs) {
            if (job.data && job.data.sessionId === sessionId) {
                try {
                    const state = await job.getState();

                    if (state === 'active') {
                        console.warn(`[Queue] ⚠️ Job ATTIVO ${job.id} (${job.queueName}) per sessione ${sessionId}. Tento sblocco...`);
                        try {
                            // We try to force a failure in order to release the lock (when possible)
                            // We use a dummy token '0'; if the lock has expired it will work.
                            // If the worker is alive this may fail, but it is worth trying.
                            await job.moveToFailed(new Error('Session Reset Forced'), '0');
                        } catch (e) {
                            // Ignoriamo errore token invalido
                        }
                    }

                    await job.remove();
                    removedCount++;
                } catch (err: any) {
                    console.warn(`[Queue] Impossibile rimuovere il job ${job.id}: ${err.message}`);

                    // Fallback estremo: Se è bloccato, proviamo a cancellare la chiave Redis direttamente?
                    // No, too risky. Keep the warning.
                }
            }
        }
    }
    return removedCount;
}
