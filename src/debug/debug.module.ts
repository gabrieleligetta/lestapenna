import { Module } from '@nestjs/common';
import { DebugService } from './debug.service';
import { DebugCommands } from './debug.commands';
import { DatabaseModule } from '../database/database.module';
import { QueueModule } from '../queue/queue.module';
import { LoggerModule } from '../logger/logger.module';
import { CampaignModule } from '../campaign/campaign.module';

@Module({
  imports: [DatabaseModule, QueueModule, LoggerModule, CampaignModule],
  providers: [DebugService, DebugCommands],
})
export class DebugModule {}
