import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { DatabaseModule } from '../database/database.module';
import { LoggerModule } from '../logger/logger.module';
import { KnowledgeRepository } from './knowledge.repository';
import { AudioModule } from '../audio/audio.module';
import { MonitorModule } from '../monitor/monitor.module';
import { TranscriptionService } from './transcription.service';

@Module({
  imports: [DatabaseModule, LoggerModule, AudioModule, MonitorModule],
  providers: [AiService, KnowledgeRepository, TranscriptionService],
  exports: [AiService, TranscriptionService],
})
export class AiModule {}
