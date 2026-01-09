import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { LoggerService } from '../logger/logger.service';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import { RecordingRepository } from '../audio/recording.repository';
import { MonitorService } from '../monitor/monitor.service';
import { TranscriptionService } from '../ai/transcription.service';
import { BackupService } from '../backup/backup.service';
import { QueueService } from '../queue/queue.service';

@Processor('audio-processing')
export class TranscriptionProcessor extends WorkerHost {
  private readonly ENABLE_AI_CORRECTION: boolean;

  constructor(
    private readonly logger: LoggerService,
    private readonly configService: ConfigService,
    private readonly recordingRepo: RecordingRepository,
    private readonly monitorService: MonitorService,
    private readonly transcriptionService: TranscriptionService,
    private readonly backupService: BackupService,
    private readonly queueService: QueueService
  ) {
    super();
    this.ENABLE_AI_CORRECTION = this.configService.get<string>('ENABLE_AI_TRANSCRIPTION_CORRECTION') !== 'false';
  }

  async process(job: Job): Promise<any> {
    const { sessionId, fileName, filePath, userId } = job.data;
    const campaignId = job.data.campaignId; // Assumiamo che venga passato o recuperato
    
    this.logger.log(`[Scriba] 🔨 Inizio elaborazione: ${fileName} (Sessione: ${sessionId})`);
    const startJob = Date.now();

    // Idempotenza
    const currentRecording = this.recordingRepo.findByFilename(fileName);
    if (currentRecording) {
        if (currentRecording.status === 'PROCESSED' || currentRecording.status === 'SKIPPED') {
            this.logger.log(`[Scriba] ⏩ File ${fileName} già elaborato. Salto.`);
            return { status: 'already_done', reason: currentRecording.status };
        }
        // Logica di recupero "Buco Nero" (TRANSCRIBED -> CORRECTION)
        if (currentRecording.status === 'TRANSCRIBED' && this.ENABLE_AI_CORRECTION) {
             this.logger.warn(`[Scriba] ⚠️ File ${fileName} trovato in stato TRANSCRIBED. Tento recupero...`);
             try {
                 const segments = JSON.parse(currentRecording.transcription_text || '[]');
                 if (segments.length > 0) {
                     await this.queueService.addCorrectionJob({
                         sessionId, fileName, segments, campaignId, userId
                     }, { jobId: `correct-${fileName}-${Date.now()}`, removeOnComplete: true });
                     return { status: 'recovered_to_correction' };
                 }
             } catch (e) {
                 this.logger.error(`[Scriba] ❌ Errore recupero JSON, procedo con ritrascrizione.`);
             }
        }
    }

    this.recordingRepo.updateStatus(fileName, 'PROCESSING');

    try {
      // 1. Recupero File
      if (!fs.existsSync(filePath)) {
        this.logger.warn(`[Scriba] ⚠️ File locale mancante. Tento download Cloud...`);
        const success = await this.backupService.downloadFromOracle(fileName, filePath, sessionId);
        if (!success) {
          this.recordingRepo.updateStatus(fileName, 'ERROR', null, 'File non trovato');
          return { status: 'failed', reason: 'file_not_found' };
        }
      }

      const stats = fs.statSync(filePath);
      if (stats.size < 5000) {
        this.logger.log(`[Scriba] 🗑️ File troppo piccolo (${stats.size} bytes). Scartato.`);
        this.recordingRepo.updateStatus(fileName, 'SKIPPED', null, 'File troppo piccolo');
        try { fs.unlinkSync(filePath); } catch(e) {}
        return { status: 'skipped', reason: 'too_small' };
      }

      // 2. TRASCRIZIONE (Whisper Locale)
      this.logger.log(`[Scriba] 🗣️  Inizio trascrizione intelligente: ${fileName}`);
      const result = await this.transcriptionService.transcribe(filePath);

      // 3. Gestione Risultato
      let audioDuration = 0;
      if (result.segments && result.segments.length > 0) {
          audioDuration = result.segments[result.segments.length - 1].end;
      }

      const processingTime = Date.now() - startJob;
      this.monitorService.logFileProcessed(audioDuration, processingTime);

      if (result.segments && result.segments.length > 0) {
          const rawJson = JSON.stringify(result.segments);
          this.recordingRepo.updateTranscription(fileName, rawJson, 'TRANSCRIBED');

          // Backup su Oracle (Se non è già stato fatto dal recorder)
          const isBackedUp = await this.backupService.uploadToOracle(filePath, fileName, sessionId);
          if (isBackedUp) {
              try {
                  fs.unlinkSync(filePath);
                  this.logger.log(`[Scriba] 🧹 File locale eliminato dopo backup: ${fileName}`);
              } catch (err) { this.logger.error(`[Scriba] Errore pulizia:`, err); }
          }

          // 4. Accodamento Correzione
          if (this.ENABLE_AI_CORRECTION) {
              this.logger.log(`[Scriba] 🧠 Invio a Correzione AI...`);
              await this.queueService.addCorrectionJob({
                  sessionId, fileName, segments: result.segments, campaignId, userId
              }, { jobId: `correct-${fileName}-${Date.now()}`, removeOnComplete: true });

              return { status: 'transcribed_queued_correction', segmentsCount: result.segments.length };
          } else {
              this.logger.log(`[Scriba] ⏩ Correzione AI OFF. Completato.`);
              this.recordingRepo.updateStatus(fileName, 'PROCESSED', rawJson);
              return { status: 'completed_raw', segmentsCount: result.segments.length };
          }

      } else {
          this.recordingRepo.updateStatus(fileName, 'SKIPPED', null, 'Silenzio o incomprensibile');
          this.logger.log(`[Scriba] 🔇 Audio scartato (silenzio).`);
          await this.backupService.uploadToOracle(filePath, fileName, sessionId);
          try { fs.unlinkSync(filePath); } catch(e) {}
          return { status: 'skipped', reason: 'silence' };
      }

    } catch (error: any) {
      this.logger.error(`[Scriba] ❌ Errore critico trascrizione ${fileName}:`, error);
      this.recordingRepo.updateStatus(fileName, 'ERROR', null, error.message);
      this.monitorService.logError('Transcription', `File: ${fileName} - ${error.message}`);
      throw error;
    }
  }
}
