import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { LoggerService } from '../logger/logger.service';

export interface Character {
  user_id: string;
  campaign_id: string;
  character_name: string;
  class: string;
  race: string;
  description: string;
}

@Injectable()
export class CharacterService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly logger: LoggerService
  ) {}

  getUserProfile(userId: string, campaignId: string): Partial<Character> {
    const row = this.dbService.getDb().prepare(
      'SELECT * FROM characters WHERE user_id = ? AND campaign_id = ?'
    ).get(userId, campaignId) as Character | undefined;

    return row || {};
  }

  updateUserCharacter(userId: string, campaignId: string, field: keyof Character, value: string): void {
    const exists = this.dbService.getDb().prepare(
      'SELECT 1 FROM characters WHERE user_id = ? AND campaign_id = ?'
    ).get(userId, campaignId);

    if (exists) {
      this.dbService.getDb().prepare(
        `UPDATE characters SET ${field} = ? WHERE user_id = ? AND campaign_id = ?`
      ).run(value, userId, campaignId);
      this.logger.log(`Aggiornato personaggio utente ${userId}: ${field} = ${value}`);
    } else {
      this.dbService.getDb().prepare(
        `INSERT INTO characters (user_id, campaign_id, ${field}) VALUES (?, ?, ?)`
      ).run(userId, campaignId, value);
      this.logger.log(`Creato nuovo personaggio per utente ${userId} con ${field} = ${value}`);
    }
  }

  getCampaignCharacters(campaignId: string): Character[] {
    return this.dbService.getDb().prepare(
      'SELECT * FROM characters WHERE campaign_id = ?'
    ).all(campaignId) as Character[];
  }

  deleteUserCharacter(userId: string, campaignId: string): void {
    this.dbService.getDb().prepare(
      'DELETE FROM characters WHERE user_id = ? AND campaign_id = ?'
    ).run(userId, campaignId);
    this.logger.log(`Eliminato personaggio utente ${userId} dalla campagna ${campaignId}`);
  }
}
