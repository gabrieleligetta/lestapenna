import { Module } from '@nestjs/common';
import { CampaignService } from './campaign.service';
import { CampaignCommands } from './campaign.commands';
import { DatabaseModule } from '../database/database.module';
import { CampaignRepository } from './campaign.repository';

@Module({
  imports: [DatabaseModule],
  providers: [CampaignService, CampaignCommands, CampaignRepository],
  exports: [CampaignService, CampaignRepository],
})
export class CampaignModule {}
