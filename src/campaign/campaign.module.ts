import { Module } from '@nestjs/common';
import { CampaignService } from './campaign.service';
import { CampaignCommands } from './campaign.commands';
import { DatabaseModule } from '../database/database.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [DatabaseModule, AiModule],
  providers: [CampaignService, CampaignCommands],
  exports: [CampaignService],
})
export class CampaignModule {}
