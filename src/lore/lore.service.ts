import { Injectable } from '@nestjs/common';
import { LoreRepository, Npc, WorldEvent, AtlasEntry, Quest, InventoryItem } from './lore.repository';
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
  listNpcs(campaignId: number): Npc[] {
    return this.loreRepo.findAllNpcs(campaignId);
  }

  getNpcEntry(campaignId: number, name: string): Npc | undefined {
    return this.loreRepo.findNpcByName(campaignId, name);
  }

  updateNpcEntry(campaignId: number, name: string, description: string, role?: string, status?: string): void {
    this.loreRepo.upsertNpc(campaignId, name, role || 'Sconosciuto', description, status || 'ALIVE');
    this.logger.log(`Aggiornato/Creato NPC ${name}`);
  }

  getEncounteredNpcs(sessionId: string): Npc[] {
      return this.loreRepo.findEncounteredNpcs(sessionId);
  }

  // --- TIMELINE ---
  getWorldTimeline(campaignId: number): WorldEvent[] {
    return this.loreRepo.getTimeline(campaignId);
  }

  addWorldEvent(campaignId: number, sessionId: string | null, description: string, type: string, year: number): void {
    this.loreRepo.addEvent(campaignId, sessionId, description, type, year);
    this.logger.log(`Aggiunto evento storico anno ${year}: ${description}`);
  }

  setCampaignYear(campaignId: number, year: number): void {
    this.campaignRepo.setYear(campaignId, year);
    this.logger.log(`Anno corrente campagna ${campaignId} impostato a ${year}`);
  }

  // --- ATLAS ---
  updateAtlasEntry(campaignId: number, macro: string, micro: string, description: string): void {
      this.loreRepo.upsertAtlasEntry(campaignId, macro, micro, description);
      this.logger.log(`Aggiornato Atlante: ${macro} - ${micro}`);
  }

  getAtlasEntry(campaignId: number, macro: string, micro: string): AtlasEntry | undefined {
      return this.loreRepo.getAtlasEntry(campaignId, macro, micro);
  }

  // --- QUESTS ---
  addQuest(campaignId: number, title: string): void {
      this.loreRepo.addQuest(campaignId, title);
      this.logger.log(`Quest aggiunta: ${title}`);
  }

  getOpenQuests(campaignId: number): Quest[] {
      return this.loreRepo.getOpenQuests(campaignId);
  }

  completeQuest(campaignId: number, titleSearch: string): boolean {
      const success = this.loreRepo.updateQuestStatus(campaignId, titleSearch, 'COMPLETED');
      if (success) this.logger.log(`Quest completata: ${titleSearch}`);
      return success;
  }

  // --- INVENTORY ---
  addLoot(campaignId: number, item: string): void {
      this.loreRepo.addLoot(campaignId, item);
      this.logger.log(`Loot aggiunto: ${item}`);
  }

  removeLoot(campaignId: number, itemSearch: string): boolean {
      const success = this.loreRepo.removeLoot(campaignId, itemSearch);
      if (success) this.logger.log(`Loot rimosso: ${itemSearch}`);
      return success;
  }

  getInventory(campaignId: number): InventoryItem[] {
      return this.loreRepo.getInventory(campaignId);
  }
}
