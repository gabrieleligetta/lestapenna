import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface Character {
  user_id: string;
  campaign_id: string;
  character_name: string;
  class: string;
  race: string;
  description: string;
}

@Injectable()
export class CharacterRepository {
  constructor(private readonly dbService: DatabaseService) {}

  upsert(userId: string, campaignId: string, field: string, value: string): void {
    const exists = this.dbService.getDb().prepare(
      'SELECT user_id FROM characters WHERE user_id = ? AND campaign_id = ?'
    ).get(userId, campaignId);

    if (exists) {
      this.dbService.getDb().prepare(
        `UPDATE characters SET ${field} = ? WHERE user_id = ? AND campaign_id = ?`
      ).run(value, userId, campaignId);
    } else {
      this.dbService.getDb().prepare(
        `INSERT INTO characters (user_id, campaign_id, ${field}) VALUES (?, ?, ?)`
      ).run(userId, campaignId, value);
    }
  }

  findByUser(userId: string, campaignId: string): Character | undefined {
    return this.dbService.getDb().prepare(
      'SELECT * FROM characters WHERE user_id = ? AND campaign_id = ?'
    ).get(userId, campaignId) as Character | undefined;
  }

  findAll(campaignId: string): Character[] {
    return this.dbService.getDb().prepare(
      'SELECT * FROM characters WHERE campaign_id = ?'
    ).all(campaignId) as Character[];
  }

  // Alias per compatibilità
  findByCampaign(campaignId: string): Character[] {
      return this.findAll(campaignId);
  }

  getHistory(campaignId: string, charName: string): any[] {
      try {
          return this.dbService.getDb().prepare(
              'SELECT * FROM character_events WHERE campaign_id = ? AND character_name = ? ORDER BY timestamp ASC'
          ).all(campaignId, charName);
      } catch (e) {
          return [];
      }
  }

  delete(userId: string, campaignId: string): void {
    this.dbService.getDb().prepare(
      'DELETE FROM characters WHERE user_id = ? AND campaign_id = ?'
    ).run(userId, campaignId);
  }
}
