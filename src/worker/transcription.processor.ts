import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { TranscriptionService } from '../ai/transcription.service';
import { DatabaseService } from '../database/database.service';
import { LoggerService } from '../logger/logger.service';
import { MonitorService } from '../monitor/monitor.service';
import * as fs from 'fs';

@Processor('audio-processing')
export class TranscriptionProcessor extends WorkerHost {
  constructor(
    private readonly transcriptionService: TranscriptionService,
    private readonly dbService: DatabaseService,
    private readonly logger: LoggerService,
    private readonly monitorService: MonitorService
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { sessionId, fileName, filePath, userId } = job.data;
    this.logger.log(`[Worker] 🔨 Inizio trascrizione job ${job.id} (${fileName})`);
    const start = Date.now();

    try {
      const result = await this.transcriptionService.transcribe(filePath);

      const campaignId = this.dbService.getDb().prepare('SELECT campaign_id FROM sessions WHERE session_id = ?').get(sessionId) as { campaign_id: string } | undefined;
      let characterName = "Sconosciuto";

      if (campaignId) {
        const char = this.dbService.getDb().prepare('SELECT character_name FROM characters WHERE user_id = ? AND campaign_id = ?').get(userId, campaignId.campaign_id) as { character_name: string } | undefined;
        if (char) characterName = char.character_name;
      }

      this.dbService.getDb().prepare(
        'UPDATE recordings SET status = ?, transcription_text = ? WHERE filename = ?'
      ).run('PROCESSED', JSON.stringify(result.segments), fileName);

      this.logger.log(`[Worker] ✅ Trascrizione completata per ${fileName}`);

      // Log metriche
      // Calcoliamo durata audio approssimativa (es. da dimensione file o da result.segments)
      // Qui usiamo una stima basata sui segmenti
      const durationSec = result.segments.length > 0 ? result.segments[result.segments.length - 1].end : 0;
      this.monitorService.logFileProcessed(durationSec, Date.now() - start);

      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch {}
      }

      return { success: true, segments: result.segments.length };

    } catch (error: any) {
      this.logger.error(`[Worker] ❌ Errore trascrizione ${fileName}:`, error);
      this.dbService.getDb().prepare(
        'UPDATE recordings SET status = ? WHERE filename = ?'
      ).run('FAILED', fileName);
      throw error;
    }
  }
}
