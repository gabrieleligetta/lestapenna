import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

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
  session_id?: string;
  description: string;
  event_type: string;
  year: number;
}

@Injectable()
export class LoreRepository {
  constructor(private readonly dbService: DatabaseService) {}

  // --- NPC ---
  upsertNpc(campaignId: string, name: string, role: string, description: string, status: string): void {
    const exists = this.dbService.getDb().prepare(
      'SELECT id FROM npcs WHERE campaign_id = ? AND name = ?'
    ).get(campaignId, name) as { id: number } | undefined;

    if (exists) {
      this.dbService.getDb().prepare(
        'UPDATE npcs SET role = ?, description = ?, status = ?, last_updated = ? WHERE id = ?'
      ).run(role, description, status, Date.now(), exists.id);
    } else {
      this.dbService.getDb().prepare(
        'INSERT INTO npcs (campaign_id, name, role, description, status, last_updated) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(campaignId, name, role, description, status, Date.now());
    }
  }

  findNpcByName(campaignId: string, name: string): Npc | undefined {
    return this.dbService.getDb().prepare(
      'SELECT * FROM npcs WHERE campaign_id = ? AND name LIKE ?'
    ).get(campaignId, name) as Npc | undefined;
  }

  findAllNpcs(campaignId: string): Npc[] {
    return this.dbService.getDb().prepare(
      'SELECT * FROM npcs WHERE campaign_id = ? ORDER BY last_updated DESC'
    ).all(campaignId) as Npc[];
  }

  // --- World Events ---
  addEvent(campaignId: string, sessionId: string | null, description: string, type: string, year: number): void {
    this.dbService.getDb().prepare(
      'INSERT INTO world_events (campaign_id, session_id, description, event_type, year) VALUES (?, ?, ?, ?, ?)'
    ).run(campaignId, sessionId, description, type, year);
  }

  getTimeline(campaignId: string): WorldEvent[] {
    return this.dbService.getDb().prepare(
      'SELECT * FROM world_events WHERE campaign_id = ? ORDER BY year ASC'
    ).all(campaignId) as WorldEvent[];
  }
}
