import { Module } from '@nestjs/common';
import { AudioService } from './audio.service';
import { PodcastMixerService } from './podcast-mixer.service';
import { QueueModule } from '../queue/queue.module';
import { DatabaseModule } from '../database/database.module';
import { LoggerModule } from '../logger/logger.module';
import { BackupModule } from '../backup/backup.module';
import { AudioListener } from '../listeners/audio.listener';
import { RecordingRepository } from './recording.repository';

@Module({
  imports: [QueueModule, DatabaseModule, LoggerModule, BackupModule],
  providers: [AudioService, AudioListener, PodcastMixerService, RecordingRepository],
  exports: [AudioService, PodcastMixerService, RecordingRepository],
})
export class AudioModule {}
