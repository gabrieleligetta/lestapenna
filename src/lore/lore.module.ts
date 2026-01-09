import { Module } from '@nestjs/common';
import { LoreService } from './lore.service';
import { LoreCommands } from './lore.commands';
import { DatabaseModule } from '../database/database.module';
import { CampaignModule } from '../campaign/campaign.module';
import { SessionModule } from '../session/session.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [DatabaseModule, CampaignModule, SessionModule, AiModule],
  providers: [LoreService, LoreCommands],
  exports: [LoreService],
})
export class LoreModule {}
