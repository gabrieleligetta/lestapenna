import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { DatabaseModule } from '../database/database.module';
import { LoggerModule } from '../logger/logger.module';
import { KnowledgeRepository } from './knowledge.repository';
import { SessionModule } from '../session/session.module';
import { CharacterModule } from '../character/character.module';
import { AudioModule } from '../audio/audio.module';

@Module({
  imports: [DatabaseModule, LoggerModule, SessionModule, CharacterModule, AudioModule],
  providers: [AiService, KnowledgeRepository],
  exports: [AiService],
})
export class AiModule {}
