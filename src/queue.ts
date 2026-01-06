import { Queue } from 'bullmq';

// Configurazione Redis
const connection = { 
    host: process.env.REDIS_HOST || 'redis', 
    port: parseInt(process.env.REDIS_PORT || '6379') 
};

// Coda Audio (Trascrizione)
export const audioQueue = new Queue('audio-processing', { connection });

// Coda Correzione (AI Post-Processing)
export const correctionQueue = new Queue('correction-processing', { connection });

/**
 * Rimuove TUTTI i job (anche attivi) associati a una specifica sessione da entrambe le code.
 */
export async function removeSessionJobs(sessionId: string) {
    let removedCount = 0;

    const queues = [audioQueue, correctionQueue];

    for (const queue of queues) {
        // Recuperiamo tutti i job in qualsiasi stato
        const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'failed', 'completed']);
        
        for (const job of jobs) {
            if (job.data && job.data.sessionId === sessionId) {
                try {
                    const state = await job.getState();
                    
                    // Se è attivo, lo rimuoviamo comunque per garantire un reset pulito.
                    // Il worker potrebbe continuare a lavorare "a vuoto", ma il risultato sarà ignorato/non salvato correttamente
                    // o sovrascritto dal nuovo job riaccodato.
                    if (state === 'active') {
                        console.warn(`[Queue] ⚠️ Rimozione forzata job ATTIVO ${job.id} (${job.queueName}) per sessione ${sessionId}.`);
                    }

                    await job.remove();
                    removedCount++;
                } catch (err: any) {
                    console.warn(`[Queue] Impossibile rimuovere il job ${job.id}: ${err.message}`);
                }
            }
        }
    }
    return removedCount;
}

/**
 * Svuota completamente le code e rimuove ogni metadato da Redis.
 */
export async function clearQueue() {
    console.log("[Queue] 🧹 Svuotamento completo delle code in corso...");
    
    const queues = [audioQueue, correctionQueue];
    
    for (const queue of queues) {
        await queue.pause();
        await queue.drain(true);
        await queue.clean(0, 1000, 'completed');
        await queue.clean(0, 1000, 'failed');
        await queue.resume(); // Importante riprendere dopo il drain se vogliamo che la coda torni usabile
    }
    
    console.log("[Queue] ✅ Code svuotate.");
}
