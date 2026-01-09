import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { NecordModule } from 'necord';
import { IntentsBitField } from 'discord.js';
import { DatabaseModule } from './database/database.module';
import { RepositoryModule } from './database/repository.module';
import { LoggerModule } from './logger/logger.module';
import { CampaignModule } from './campaign/campaign.module';
import { CharacterModule } from './character/character.module';
import { LoreModule } from './lore/lore.module';
import { QueueModule } from './queue/queue.module';
import { AudioModule } from './audio/audio.module';
import { SessionModule } from './session/session.module';
import { AiModule } from './ai/ai.module';
import { WorkerModule } from './worker/worker.module';
import { DebugModule } from './debug/debug.module';
import { SystemModule } from './system/system.module';
import { BackupModule } from './backup/backup.module';
import { MonitorModule } from './monitor/monitor.module';
import { ReporterModule } from './reporter/reporter.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    EventEmitterModule.forRoot(),
    NecordModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        token: configService.get<string>('DISCORD_BOT_TOKEN')!,
        intents: [
          IntentsBitField.Flags.Guilds,
          IntentsBitField.Flags.GuildMessages,
          IntentsBitField.Flags.MessageContent,
          IntentsBitField.Flags.GuildVoiceStates,
        ],
      }),
      inject: [ConfigService],
    }),
    DatabaseModule,
    RepositoryModule,
    LoggerModule,
    QueueModule,
    CampaignModule,
    CharacterModule,
    LoreModule,
    AudioModule,
    SessionModule,
    AiModule,
    WorkerModule,
    DebugModule,
    SystemModule,
    BackupModule,
    MonitorModule,
    ReporterModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
