import { Module } from '@nestjs/common';
import { LoreService } from './lore.service';
import { LoreCommands } from './lore.commands';
import { DatabaseModule } from '../database/database.module';
import { CampaignModule } from '../campaign/campaign.module';
import { LoreRepository } from './lore.repository';

@Module({
  imports: [DatabaseModule, CampaignModule],
  providers: [LoreService, LoreCommands, LoreRepository],
  exports: [LoreService, LoreRepository],
})
export class LoreModule {}
