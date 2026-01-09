import { Module } from '@nestjs/common';
import { SessionService } from './session.service';
import { SessionCommands } from './session.commands';
import { AudioModule } from '../audio/audio.module';
import { CampaignModule } from '../campaign/campaign.module';
import { BackupModule } from '../backup/backup.module';
import { MonitorModule } from '../monitor/monitor.module';

@Module({
  imports: [AudioModule, CampaignModule, BackupModule, MonitorModule],
  providers: [SessionService, SessionCommands],
  exports: [SessionService],
})
export class SessionModule {}
