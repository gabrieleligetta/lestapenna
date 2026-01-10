import { Module } from '@nestjs/common';
import { TranscriptionProcessor } from './transcription.processor';
import { SummaryProcessor } from './summary.processor';
import { CorrectionProcessor } from './correction.processor';
import { AiModule } from '../ai/ai.module';
import { DatabaseModule } from '../database/database.module';
import { LoggerModule } from '../logger/logger.module';
import { QueueModule } from '../queue/queue.module';
import { MonitorModule } from '../monitor/monitor.module';
import { ReporterModule } from '../reporter/reporter.module';
import { DiscordClientProvider } from '../discord/discord-client.provider';
import { LoreModule } from '../lore/lore.module';
import { SessionModule } from '../session/session.module';
import { CampaignModule } from '../campaign/campaign.module';
import { CharacterModule } from '../character/character.module';

@Module({
  imports: [AiModule, DatabaseModule, LoggerModule, QueueModule, MonitorModule, ReporterModule, LoreModule, SessionModule, CampaignModule, CharacterModule],
  providers: [TranscriptionProcessor, SummaryProcessor, CorrectionProcessor, DiscordClientProvider],
})
export class WorkerModule {}
