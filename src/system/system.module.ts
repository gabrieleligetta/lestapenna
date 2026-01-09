import { Module } from '@nestjs/common';
import { SystemCommands } from './system.commands';
import { RecoveryService } from './recovery.service';
import { QueueModule } from '../queue/queue.module';
import { DatabaseModule } from '../database/database.module';
import { BackupModule } from '../backup/backup.module';
import { LoggerModule } from '../logger/logger.module';
import { AudioModule } from '../audio/audio.module';
import { RecordingRepository } from '../audio/recording.repository';
import { SessionRepository } from '../session/session.repository';
import { ConfigRepository } from './config.repository';

@Module({
  imports: [QueueModule, DatabaseModule, BackupModule, LoggerModule, AudioModule],
  providers: [SystemCommands, RecoveryService, RecordingRepository, SessionRepository, ConfigRepository],
  exports: [RecoveryService, ConfigRepository]
})
export class SystemModule {}
