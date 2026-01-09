import { Module } from '@nestjs/common';
import { CampaignService } from './campaign.service';
import { CampaignCommands } from './campaign.commands';

@Module({
  providers: [CampaignService, CampaignCommands],
  exports: [CampaignService],
})
export class CampaignModule {}
