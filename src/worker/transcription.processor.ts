import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { LoggerService } from '../logger/logger.service';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import OpenAI from 'openai';
import { RecordingRepository } from '../audio/recording.repository';
import { SessionRepository } from '../session/session.repository';
import { CharacterRepository } from '../character/character.repository';

@Processor('audio-processing')
export class TranscriptionProcessor extends WorkerHost {
  private openai: OpenAI;

  constructor(
    private readonly logger: LoggerService,
    private readonly configService: ConfigService,
    private readonly recordingRepo: RecordingRepository,
    private readonly sessionRepo: SessionRepository,
    private readonly characterRepo: CharacterRepository
  ) {
    super();
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('OPENAI_API_KEY'),
    });
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { sessionId, fileName, filePath, userId } = job.data;
    this.logger.log(`[Worker] 🎙️ Inizio trascrizione: ${fileName}`);

    try {
      this.recordingRepo.updateStatus(fileName, 'PROCESSING');

      if (!fs.existsSync(filePath)) {
        throw new Error(`File non trovato: ${filePath}`);
      }

      const fileStream = fs.createReadStream(filePath);

      const transcription = await this.openai.audio.transcriptions.create({
        file: fileStream,
        model: "whisper-1",
        language: "it",
        response_format: "verbose_json",
        timestamp_granularities: ["segment"]
      });

      // Arricchimento con Speaker Name
      const session = this.sessionRepo.findById(sessionId);
      let charName = "Sconosciuto";
      if (session) {
        const char = this.characterRepo.findByUser(userId, session.campaign_id);
        if (char) charName = char.character_name;
      }

      const enrichedSegments = transcription.segments?.map((s: any) => ({
        ...s,
        speaker: charName,
        speaker_id: userId
      })) || [];

      const jsonContent = JSON.stringify(enrichedSegments);

      this.recordingRepo.updateTranscription(fileName, jsonContent, 'COMPLETED');
      
      this.logger.log(`[Worker] ✅ Trascrizione completata per ${fileName}`);
      return { success: true, segments: enrichedSegments.length };

    } catch (error: any) {
      this.logger.error(`[Worker] ❌ Errore trascrizione ${fileName}:`, error);
      this.recordingRepo.updateStatus(fileName, 'ERROR');
      throw error;
    }
  }
}
