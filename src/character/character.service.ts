import { Injectable } from '@nestjs/common';
import { CharacterRepository, Character } from './character.repository';
import { LoggerService } from '../logger/logger.service';

@Injectable()
export class CharacterService {
  constructor(
    private readonly characterRepo: CharacterRepository,
    private readonly logger: LoggerService
  ) {}

  getUserProfile(userId: string, campaignId: string): Partial<Character> {
    const char = this.characterRepo.findByUser(userId, campaignId);
    return char || {};
  }

  updateUserCharacter(userId: string, campaignId: string, field: string, value: string): void {
    this.characterRepo.upsert(userId, campaignId, field, value);
    this.logger.log(`Aggiornato personaggio utente ${userId}: ${field} = ${value}`);
  }

  getCampaignCharacters(campaignId: string): Character[] {
    return this.characterRepo.findByCampaign(campaignId);
  }

  deleteUserCharacter(userId: string, campaignId: string): void {
    this.characterRepo.delete(userId, campaignId);
    this.logger.log(`Eliminato personaggio utente ${userId} dalla campagna ${campaignId}`);
  }
}
