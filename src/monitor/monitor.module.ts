import { Module, Global } from '@nestjs/common';
import { MonitorService } from './monitor.service';
import { LoggerModule } from '../logger/logger.module';
import { ReporterModule } from '../reporter/reporter.module';

@Global()
@Module({
  imports: [LoggerModule, ReporterModule],
  providers: [MonitorService],
  exports: [MonitorService],
})
export class MonitorModule {}
