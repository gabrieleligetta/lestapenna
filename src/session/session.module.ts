import { Module } from '@nestjs/common';
import { SessionService } from './session.service';
import { SessionCommands } from './session.commands';
import { DatabaseModule } from '../database/database.module';
import { AudioModule } from '../audio/audio.module';
import { LoggerModule } from '../logger/logger.module';
import { QueueModule } from '../queue/queue.module';
import { CampaignModule } from '../campaign/campaign.module';
import { MonitorModule } from '../monitor/monitor.module';
import { BackupModule } from '../backup/backup.module';

@Module({
  imports: [
    DatabaseModule,
    AudioModule,
    LoggerModule,
    QueueModule,
    CampaignModule,
    MonitorModule,
    BackupModule
  ],
  providers: [SessionService, SessionCommands],
  exports: [SessionService],
})
export class SessionModule {}
