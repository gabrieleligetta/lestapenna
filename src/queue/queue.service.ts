import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { LoggerService } from '../logger/logger.service';

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue('audio-processing') private readonly audioQueue: Queue,
    @InjectQueue('correction-processing') private readonly correctionQueue: Queue,
    @InjectQueue('summary-processing') private readonly summaryQueue: Queue,
    private readonly logger: LoggerService
  ) {}

  async addAudioJob(data: any, opts?: any) {
    return this.audioQueue.add('transcribe-job', data, opts);
  }

  async addCorrectionJob(data: any, opts?: any) {
    return this.correctionQueue.add('correction-job', data, opts);
  }

  async addSummaryJob(data: any, opts?: any) {
    return this.summaryQueue.add('summarize-job', data, opts);
  }

  /**
   * Rimuove TUTTI i job (anche attivi) associati a una specifica sessione da tutte le code.
   */
  async removeSessionJobs(sessionId: string): Promise<number> {
    let removedCount = 0;
    const queues = [this.audioQueue, this.correctionQueue, this.summaryQueue];

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
              this.logger.warn(`[Queue] ⚠️ Rimozione forzata job ATTIVO ${job.id} (${job.queueName}) per sessione ${sessionId}.`);
            }
            await job.remove();
            removedCount++;
          } catch (err: any) {
            this.logger.warn(`[Queue] Impossibile rimuovere il job ${job.id}: ${err.message}`);
          }
        }
      }
    }
    return removedCount;
  }

  /**
   * Svuota completamente le code e rimuove ogni metadato da Redis.
   */
  async clearAllQueues() {
    this.logger.log("[Queue] 🧹 Svuotamento completo delle code in corso...");
    const queues = [this.audioQueue, this.correctionQueue, this.summaryQueue];

    for (const queue of queues) {
      await queue.pause();
      await queue.drain(true);
      await queue.clean(0, 1000, 'completed');
      await queue.clean(0, 1000, 'failed');
      await queue.resume(); // Importante riprendere dopo il drain se vogliamo che la coda torni usabile
    }
    this.logger.log("[Queue] ✅ Code svuotate.");
  }

  async getJobCounts() {
    const audio = await this.audioQueue.getJobCounts();
    const correction = await this.correctionQueue.getJobCounts();
    const summary = await this.summaryQueue.getJobCounts();
    return { audio, correction, summary };
  }
  
  getAudioQueue(): Queue { return this.audioQueue; }
  getCorrectionQueue(): Queue { return this.correctionQueue; }
  getSummaryQueue(): Queue { return this.summaryQueue; }
}
