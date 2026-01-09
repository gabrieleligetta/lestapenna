import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { LoggerService } from '../logger/logger.service';

export interface Npc {
  id: number;
  campaign_id: string;
  name: string;
  role: string;
  description: string;
  status: string;
  last_updated: number;
}

export interface WorldEvent {
  id: number;
  campaign_id: string;
  session_id: string | null;
  description: string;
  event_type: string;
  year: number;
}

@Injectable()
export class LoreService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly logger: LoggerService
  ) {}

  // --- NPC ---
  listNpcs(campaignId: string): Npc[] {
    return this.dbService.getDb().prepare(
      'SELECT * FROM npcs WHERE campaign_id = ? ORDER BY last_updated DESC LIMIT 20'
    ).all(campaignId) as Npc[];
  }

  getNpcEntry(campaignId: string, name: string): Npc | undefined {
    return this.dbService.getDb().prepare(
      'SELECT * FROM npcs WHERE campaign_id = ? AND lower(name) = lower(?)'
    ).get(campaignId, name) as Npc | undefined;
  }

  updateNpcEntry(campaignId: string, name: string, description: string, role?: string, status?: string): void {
    const existing = this.getNpcEntry(campaignId, name);
    const now = Date.now();

    if (existing) {
      this.dbService.getDb().prepare(
        `UPDATE npcs SET description = ?, last_updated = ? ${role ? ', role = ?' : ''} ${status ? ', status = ?' : ''} WHERE id = ?`
      ).run(description, now, ...(role ? [role] : []), ...(status ? [status] : []), existing.id);
      this.logger.log(`Aggiornato NPC ${name} (ID: ${existing.id})`);
    } else {
      this.dbService.getDb().prepare(
        'INSERT INTO npcs (campaign_id, name, description, role, status, last_updated) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(campaignId, name, description, role || 'Sconosciuto', status || 'ALIVE', now);
      this.logger.log(`Creato nuovo NPC ${name}`);
    }
  }

  // --- TIMELINE ---
  getWorldTimeline(campaignId: string): WorldEvent[] {
    return this.dbService.getDb().prepare(
      'SELECT * FROM world_events WHERE campaign_id = ? ORDER BY year ASC'
    ).all(campaignId) as WorldEvent[];
  }

  addWorldEvent(campaignId: string, sessionId: string | null, description: string, type: string, year: number): void {
    this.dbService.getDb().prepare(
      'INSERT INTO world_events (campaign_id, session_id, description, event_type, year) VALUES (?, ?, ?, ?, ?)'
    ).run(campaignId, sessionId, description, type, year);
    this.logger.log(`Aggiunto evento storico anno ${year}: ${description}`);
  }

  setCampaignYear(campaignId: string, year: number): void {
    this.dbService.getDb().prepare(
      'UPDATE campaigns SET current_year = ? WHERE id = ?'
    ).run(year, campaignId);
    this.logger.log(`Anno corrente campagna ${campaignId} impostato a ${year}`);
  }
}
