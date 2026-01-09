import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AudioChunkSavedEvent } from '../events/audio.events';
import { QueueService } from '../queue/queue.service';
import { LoggerService } from '../logger/logger.service';

@Injectable()
export class AudioListener {
  constructor(
    private readonly queueService: QueueService,
    private readonly logger: LoggerService
  ) {}

  @OnEvent('audio.chunk.saved')
  async handleAudioSaved(event: AudioChunkSavedEvent) {
    this.logger.log(`[Listener] 📨 Ricevuto evento audio salvato: ${event.fileName}`);
    
    await this.queueService.addAudioJob({
      sessionId: event.sessionId,
      fileName: event.fileName,
      filePath: event.filePath,
      userId: event.userId
    }, { 
      jobId: event.fileName, 
      attempts: 3, 
      removeOnComplete: true 
    });
  }
}
