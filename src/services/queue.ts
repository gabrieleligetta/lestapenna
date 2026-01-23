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
                    
                    if (state === 'active') {
                        console.warn(`[Queue] ⚠️ Job ATTIVO ${job.id} (${job.queueName}) per sessione ${sessionId}. Tento sblocco...`);
                        try {
                            // Tentiamo di forzare il fallimento per rilasciare il lock (se possibile)
                            // Usiamo un token fittizio '0', se il lock è scaduto funzionerà.
                            // Se il worker è vivo, questo potrebbe fallire, ma ci proviamo.
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
                    // No, troppo rischioso. Lasciamo il warning.
                }
            }
        }
    }
    return removedCount;
}

/**
 * Svuota completamente le code e rimuove ogni metadato da Redis.
 * Usa OBLITERATE per forzare la rimozione anche dei job bloccati.
 */
export async function clearQueue() {
    console.log("[Queue] 🧹 Svuotamento completo delle code in corso (OBLITERATE)...");
    
    const queues = [audioQueue, correctionQueue];
    
    for (const queue of queues) {
        await queue.pause();
        // Force: true permette di cancellare anche se ci sono job attivi
        await queue.obliterate({ force: true });
        await queue.resume();
    }
    
    console.log("[Queue] ✅ Code obliterate e pronte.");
}
