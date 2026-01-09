import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { v4 as uuidv4 } from 'uuid';

export interface Campaign {
  id: string;
  guild_id: string;
  name: string;
  created_at: number;
  is_active: number;
  current_year: number;
}

@Injectable()
export class CampaignService {
  constructor(private readonly dbService: DatabaseService) {}

  create(guildId: string, name: string): Campaign {
    const id = uuidv4();
    const now = Date.now();
    
    // Disattiva altre campagne
    this.dbService.getDb().prepare('UPDATE campaigns SET is_active = 0 WHERE guild_id = ?').run(guildId);
    
    // Crea nuova
    this.dbService.getDb().prepare(
      'INSERT INTO campaigns (id, guild_id, name, created_at, is_active) VALUES (?, ?, ?, ?, 1)'
    ).run(id, guildId, name, now);

    return { id, guild_id: guildId, name, created_at: now, is_active: 1, current_year: 0 };
  }

  findAll(guildId: string): Campaign[] {
    return this.dbService.getDb().prepare(
      'SELECT * FROM campaigns WHERE guild_id = ? ORDER BY created_at DESC'
    ).all(guildId) as Campaign[];
  }

  getActive(guildId: string): Campaign | undefined {
    return this.dbService.getDb().prepare(
      'SELECT * FROM campaigns WHERE guild_id = ? AND is_active = 1'
    ).get(guildId) as Campaign | undefined;
  }

  setActive(guildId: string, campaignId: string): boolean {
    const exists = this.dbService.getDb().prepare('SELECT id FROM campaigns WHERE id = ? AND guild_id = ?').get(campaignId, guildId);
    if (!exists) return false;

    this.dbService.getDb().transaction(() => {
      this.dbService.getDb().prepare('UPDATE campaigns SET is_active = 0 WHERE guild_id = ?').run(guildId);
      this.dbService.getDb().prepare('UPDATE campaigns SET is_active = 1 WHERE id = ?').run(campaignId);
    })();
    return true;
  }

  delete(campaignId: string): void {
    this.dbService.getDb().transaction(() => {
      // Cascade delete gestito dal DB per la maggior parte, ma puliamo esplicitamente per sicurezza
      this.dbService.getDb().prepare('DELETE FROM recordings WHERE session_id IN (SELECT session_id FROM sessions WHERE campaign_id = ?)').run(campaignId);
      this.dbService.getDb().prepare('DELETE FROM sessions WHERE campaign_id = ?').run(campaignId);
      this.dbService.getDb().prepare('DELETE FROM characters WHERE campaign_id = ?').run(campaignId);
      this.dbService.getDb().prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId);
    })();
  }
}
