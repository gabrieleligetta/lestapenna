import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface GuildConfig {
  guild_id: string;
  cmd_channel_id?: string;
  summary_channel_id?: string;
}

@Injectable()
export class ConfigRepository {
  constructor(private readonly dbService: DatabaseService) {}

  getConfig(guildId: string): GuildConfig | undefined {
    return this.dbService.getDb().prepare(
      'SELECT * FROM guild_config WHERE guild_id = ?'
    ).get(guildId) as GuildConfig | undefined;
  }

  setConfig(guildId: string, field: 'cmd_channel_id' | 'summary_channel_id', channelId: string): void {
    const exists = this.getConfig(guildId);
    if (exists) {
      this.dbService.getDb().prepare(
        `UPDATE guild_config SET ${field} = ? WHERE guild_id = ?`
      ).run(channelId, guildId);
    } else {
      this.dbService.getDb().prepare(
        `INSERT INTO guild_config (guild_id, ${field}) VALUES (?, ?)`
      ).run(guildId, channelId);
    }
  }
}
