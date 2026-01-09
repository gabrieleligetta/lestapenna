import { Module } from '@nestjs/common';
import { SystemCommands } from './system.commands';
import { QueueModule } from '../queue/queue.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [QueueModule, DatabaseModule],
  providers: [SystemCommands],
})
export class SystemModule {}
