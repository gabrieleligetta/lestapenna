import { Module } from '@nestjs/common';
import { TranscriptionService } from './transcription.service';
import { AiService } from './ai.service';
import { LoggerModule } from '../logger/logger.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [LoggerModule, DatabaseModule],
  providers: [TranscriptionService, AiService],
  exports: [TranscriptionService, AiService],
})
export class AiModule {}
