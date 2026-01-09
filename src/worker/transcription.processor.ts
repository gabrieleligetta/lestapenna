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
import { CharacterRepository } from '../character/character.repository';

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
    private readonly queueService: QueueService,
    private readonly characterRepo: CharacterRepository
  ) {
    super();
    this.ENABLE_AI_CORRECTION = this.configService.get<string>('ENABLE_AI_TRANSCRIPTION_CORRECTION') !== 'false';
  }

  async process(job: Job): Promise<any> {
    // --- 1. GESTIONE SENTINELLA (AGGIORNATA) ---
    if (job.data.isSentinel) {
        const { sessionId, channelId, guildId } = job.data;
        this.logger.log(`[Scriba] 🛑 Sentinel Job processato per ${sessionId}.`);

        if (this.ENABLE_AI_CORRECTION) {
            // CASO A: Correzione Attiva.
            // Passiamo la palla al worker di correzione.
            this.logger.log(`[Scriba] 🔗 Correzione attiva: inoltro la Sentinella alla coda Correzione.`);
            
            await this.queueService.addCorrectionJob({
                isSentinel: true, // Flag mantenuto
                sessionId,
                channelId,
                guildId,
                // Dati dummy
                fileName: 'SENTINEL-CORRECTION',
                segments: [] 
            }, {
                jobId: `sentinel-correction-${sessionId}`,
                removeOnComplete: true
            });
            
            return { status: 'sentinel_forwarded_to_correction' };
        } else {
            // CASO B: Correzione Disabilitata.
            // Possiamo lanciare direttamente il riassunto (come facevamo prima).
            this.logger.log(`[Scriba] ⏩ Correzione disabilitata: avvio diretto del Riassunto.`);
            
            await this.queueService.addSummaryJob({
                sessionId,
                channelId,
                guildId
            });
            
            return { status: 'sentinel_triggered_summary' };
        }
    }
    // -------------------------------------------

    const { sessionId, fileName, filePath, userId, campaignId } = job.data;
    
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
                         sessionId, 
                         fileName, 
                         segments, 
                         campaignId, 
                         userId,
                         // Passiamo anche i dati per il riassunto nel caso di recupero
                         triggerSummary: job.data.triggerSummary,
                         channelId: job.data.channelId,
                         guildId: job.data.guildId
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

          // --- FIX IDENTITÀ STORICA ---
          // Recuperiamo il nome ORA e lo salviamo per sempre
          if (campaignId && userId) {
             const char = this.characterRepo.findByUser(userId, campaignId);
             if (char && char.character_name) {
                 this.recordingRepo.updateCharacterName(fileName, char.character_name);
                 this.logger.log(`[Scriba] 🧊 Identità congelata per ${fileName}: ${char.character_name}`);
             }
          }
          // ----------------------------

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
              this.logger.log(`[Scriba] 🧠 Invio a Correzione AI (Il riassunto sarà scatenato dopo)...`);
              
              // Passiamo triggerSummary e i dati del canale al job di correzione
              await this.queueService.addCorrectionJob({
                  sessionId, 
                  fileName, 
                  segments: result.segments, 
                  campaignId, 
                  userId,
                  // Dati aggiuntivi per concatenare il riassunto dopo
                  triggerSummary: job.data.triggerSummary, 
                  channelId: job.data.channelId, 
                  guildId: job.data.guildId
              }, { jobId: `correct-${fileName}-${Date.now()}`, removeOnComplete: true });

              return { status: 'transcribed_queued_correction', segmentsCount: result.segments.length };

          } else {
              // CASO B: Correzione AI OFF.
              // Procediamo alla vecchia maniera: salviamo raw e lanciamo il riassunto subito.
              
              this.logger.log(`[Scriba] ⏩ Correzione AI OFF. Completato.`);
              this.recordingRepo.updateStatus(fileName, 'PROCESSED', rawJson);

              // Logica "Legacy-Style" (Sequenziale Immediata)
              if (job.data.triggerSummary && job.data.channelId && job.data.guildId) {
                  this.logger.log(`[Scriba] 🔗 Trascrizione Raw salvata. Attivo generazione riassunto per ${sessionId}...`);
                  await this.queueService.addSummaryJob({
                      sessionId: sessionId,
                      channelId: job.data.channelId,
                      guildId: job.data.guildId
                  });
              }

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
