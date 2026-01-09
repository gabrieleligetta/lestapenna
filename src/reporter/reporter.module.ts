import { Module, Global } from '@nestjs/common';
import { ReporterService } from './reporter.service';
import { DatabaseModule } from '../database/database.module';
import { BackupModule } from '../backup/backup.module';
import { LoggerModule } from '../logger/logger.module';

@Global()
@Module({
  imports: [DatabaseModule, BackupModule, LoggerModule],
  providers: [ReporterService],
  exports: [ReporterService],
})
export class ReporterModule {}
