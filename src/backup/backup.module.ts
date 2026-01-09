import { Module, Global } from '@nestjs/common';
import { BackupService } from './backup.service';
import { LoggerModule } from '../logger/logger.module';

@Global()
@Module({
  imports: [LoggerModule],
  providers: [BackupService],
  exports: [BackupService],
})
export class BackupModule {}
