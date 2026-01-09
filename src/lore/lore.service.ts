import { Injectable } from '@nestjs/common';
import { LoreRepository, Npc, WorldEvent } from './lore.repository';
import { CampaignRepository } from '../campaign/campaign.repository';
import { LoggerService } from '../logger/logger.service';

@Injectable()
export class LoreService {
  constructor(
    private readonly loreRepo: LoreRepository,
    private readonly campaignRepo: CampaignRepository,
    private readonly logger: LoggerService
  ) {}

  // --- NPC ---
  listNpcs(campaignId: string): Npc[] {
    return this.loreRepo.findAllNpcs(campaignId);
  }

  getNpcEntry(campaignId: string, name: string): Npc | undefined {
    return this.loreRepo.findNpcByName(campaignId, name);
  }

  updateNpcEntry(campaignId: string, name: string, description: string, role?: string, status?: string): void {
    // Logica di upsert delegata al repository o gestita qui se complessa
    // Il repo ha upsertNpc che prende tutto.
    this.loreRepo.upsertNpc(campaignId, name, role || 'Sconosciuto', description, status || 'ALIVE');
    this.logger.log(`Aggiornato/Creato NPC ${name}`);
  }

  // --- TIMELINE ---
  getWorldTimeline(campaignId: string): WorldEvent[] {
    return this.loreRepo.getTimeline(campaignId);
  }

  addWorldEvent(campaignId: string, sessionId: string | null, description: string, type: string, year: number): void {
    this.loreRepo.addEvent(campaignId, sessionId, description, type, year);
    this.logger.log(`Aggiunto evento storico anno ${year}: ${description}`);
  }

  setCampaignYear(campaignId: string, year: number): void {
    this.campaignRepo.setYear(campaignId, year);
    this.logger.log(`Anno corrente campagna ${campaignId} impostato a ${year}`);
  }
}
