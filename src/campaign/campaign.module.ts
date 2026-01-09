import { Module } from '@nestjs/common';
import { CampaignService } from './campaign.service';
import { CampaignCommands } from './campaign.commands';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  providers: [CampaignService, CampaignCommands],
  exports: [CampaignService],
})
export class CampaignModule {}
