import { Injectable } from '@nestjs/common';
import { CampaignRepository, Campaign } from './campaign.repository';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CampaignService {
  constructor(private readonly campaignRepo: CampaignRepository) {}

  create(guildId: string, name: string): Campaign {
    const id = uuidv4();
    this.campaignRepo.setActive(guildId, ''); // Disattiva tutte (hacky ma efficace se id vuoto non matcha nulla)
    // Meglio: implementare deactivateAll in repo, ma setActive fa già switch se implementato bene.
    // Guardando il repo: setActive fa update is_active=0 per guild, poi is_active=1 per id.
    // Quindi chiamiamo create poi setActive.
    
    this.campaignRepo.create(id, guildId, name);
    this.campaignRepo.setActive(guildId, id);

    return { id, guild_id: guildId, name, created_at: Date.now(), is_active: 1, current_year: 0 };
  }

  findAll(guildId: string): Campaign[] {
    return this.campaignRepo.findAll(guildId);
  }

  getActive(guildId: string): Campaign | undefined {
    return this.campaignRepo.findActive(guildId);
  }

  setActive(guildId: string, campaignId: string): boolean {
    const exists = this.campaignRepo.findById(campaignId);
    if (!exists || exists.guild_id !== guildId) return false;

    this.campaignRepo.setActive(guildId, campaignId);
    return true;
  }

  delete(campaignId: string): void {
    this.campaignRepo.delete(campaignId);
  }
}
