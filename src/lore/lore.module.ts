import { Module } from '@nestjs/common';
import { LoreService } from './lore.service';
import { LoreCommands } from './lore.commands';
import { CampaignModule } from '../campaign/campaign.module';

@Module({
  imports: [CampaignModule],
  providers: [LoreService, LoreCommands],
  exports: [LoreService],
})
export class LoreModule {}
