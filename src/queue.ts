import { Queue } from 'bullmq';

// Configurazione Coda
// Assicurati che l'host corrisponda al nome del servizio nel docker-compose (es. 'redis')
export const audioQueue = new Queue('audio-processing', { 
    connection: { 
        host: process.env.REDIS_HOST || 'redis', 
        port: parseInt(process.env.REDIS_PORT || '6379') 
    } 
});

/**
 * Rimuove tutti i job in attesa associati a una specifica sessione.
 * Utile per evitare duplicati quando si forza un reset.
 */
export async function removeSessionJobs(sessionId: string) {
    // Recuperiamo i job in vari stati
    const jobs = await audioQueue.getJobs(['waiting', 'delayed', 'active', 'failed', 'completed']);
    let removedCount = 0;

    for (const job of jobs) {
        if (job.data && job.data.sessionId === sessionId) {
            try {
                const state = await job.getState();
                if (state === 'active') {
                    console.log(`[Queue] Job ${job.id} (${job.data?.fileName}) è già in elaborazione, non lo rimuovo.`);
                    continue;
                }
                await job.remove();
                removedCount++;
            } catch (err: any) {
                console.warn(`[Queue] Impossibile rimuovere il job ${job.id}: ${err.message}`);
            }
        }
    }
    return removedCount;
}

/**
 * Svuota completamente la coda e rimuove ogni metadato da Redis.
 */
export async function clearQueue() {
    console.log("[Queue] 🧹 Svuotamento completo della coda in corso...");
    await audioQueue.pause();
    await audioQueue.drain(true); // Rimuove tutti i job in attesa
    await audioQueue.clean(0, 1000, 'completed');
    await audioQueue.clean(0, 1000, 'failed');
    console.log("[Queue] ✅ Coda svuotata.");
}
