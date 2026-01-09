import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface Campaign {
  id: string;
  guild_id: string;
  name: string;
  created_at: number;
  is_active: number;
  current_year: number;
}

@Injectable()
export class CampaignRepository {
  constructor(private readonly dbService: DatabaseService) {}

  create(id: string, guildId: string, name: string): void {
    this.dbService.getDb().prepare(
      'INSERT INTO campaigns (id, guild_id, name, created_at, is_active) VALUES (?, ?, ?, ?, 1)'
    ).run(id, guildId, name, Date.now());
  }

  findAll(guildId: string): Campaign[] {
    return this.dbService.getDb().prepare(
      'SELECT * FROM campaigns WHERE guild_id = ?'
    ).all(guildId) as Campaign[];
  }

  findActive(guildId: string): Campaign | undefined {
    return this.dbService.getDb().prepare(
      'SELECT * FROM campaigns WHERE guild_id = ? AND is_active = 1'
    ).get(guildId) as Campaign | undefined;
  }

  findById(id: string): Campaign | undefined {
    return this.dbService.getDb().prepare(
      'SELECT * FROM campaigns WHERE id = ?'
    ).get(id) as Campaign | undefined;
  }

  setActive(guildId: string, campaignId: string): void {
    const db = this.dbService.getDb();
    db.transaction(() => {
      db.prepare('UPDATE campaigns SET is_active = 0 WHERE guild_id = ?').run(guildId);
      db.prepare('UPDATE campaigns SET is_active = 1 WHERE id = ?').run(campaignId);
    })();
  }

  setYear(campaignId: string, year: number): void {
    this.dbService.getDb().prepare(
      'UPDATE campaigns SET current_year = ? WHERE id = ?'
    ).run(year, campaignId);
  }
}
