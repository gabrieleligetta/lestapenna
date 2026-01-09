import { Injectable } from '@nestjs/common';
import { CampaignRepository, Campaign } from './campaign.repository';

@Injectable()
export class CampaignService {
  constructor(private readonly campaignRepo: CampaignRepository) {}

  create(guildId: string, name: string): Campaign {
    // Disattiva tutte le altre campagne prima di crearne una nuova attiva
    // Usiamo un ID fittizio -1 per disattivare tutto senza attivare nulla di esistente
    this.campaignRepo.setActive(guildId, -1);
    
    const id = this.campaignRepo.create(guildId, name);
    // La nuova campagna viene creata con is_active=1 dal repository

    return { id, guild_id: guildId, name, created_at: Date.now(), is_active: 1, current_year: 0 };
  }

  findAll(guildId: string): Campaign[] {
    return this.campaignRepo.findAll(guildId);
  }

  getActive(guildId: string): Campaign | undefined {
    return this.campaignRepo.findActive(guildId);
  }

  setActive(guildId: string, campaignId: number): boolean {
    const exists = this.campaignRepo.findById(campaignId);
    if (!exists || exists.guild_id !== guildId) return false;

    this.campaignRepo.setActive(guildId, campaignId);
    return true;
  }

  delete(campaignId: number): void {
    this.campaignRepo.delete(campaignId);
  }
}
