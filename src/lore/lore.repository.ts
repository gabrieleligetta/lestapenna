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

export interface AtlasEntry {
    id: number;
    campaign_id: string;
    macro_location: string;
    micro_location: string;
    description: string;
    last_updated: number;
}

export interface Quest {
    id: number;
    campaign_id: string;
    title: string;
    status: string; // OPEN, COMPLETED, FAILED
    created_at: number;
    updated_at: number;
}

export interface InventoryItem {
    id: number;
    campaign_id: string;
    item_name: string;
    quantity: number;
    added_at: number;
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

  findEncounteredNpcs(sessionId: string): Npc[] {
    return this.dbService.getDb().prepare(`
        SELECT DISTINCT n.name, n.role, n.description, n.status 
        FROM npcs n 
        JOIN recordings r ON r.present_npcs LIKE '%' || n.name || '%' 
        WHERE r.session_id = ?
    `).all(sessionId) as Npc[];
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

  // --- Atlas ---
  upsertAtlasEntry(campaignId: string, macro: string, micro: string, description: string): void {
      const exists = this.dbService.getDb().prepare(
          'SELECT id FROM atlas WHERE campaign_id = ? AND macro_location = ? AND micro_location = ?'
      ).get(campaignId, macro, micro) as { id: number } | undefined;

      if (exists) {
          this.dbService.getDb().prepare(
              'UPDATE atlas SET description = ?, last_updated = ? WHERE id = ?'
          ).run(description, Date.now(), exists.id);
      } else {
          this.dbService.getDb().prepare(
              'INSERT INTO atlas (campaign_id, macro_location, micro_location, description, last_updated) VALUES (?, ?, ?, ?, ?)'
          ).run(campaignId, macro, micro, description, Date.now());
      }
  }

  getAtlasEntry(campaignId: string, macro: string, micro: string): AtlasEntry | undefined {
      return this.dbService.getDb().prepare(
          'SELECT * FROM atlas WHERE campaign_id = ? AND macro_location = ? AND micro_location = ?'
      ).get(campaignId, macro, micro) as AtlasEntry | undefined;
  }

  // --- Quests ---
  addQuest(campaignId: string, title: string): void {
      this.dbService.getDb().prepare(
          'INSERT INTO quests (campaign_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(campaignId, title, 'OPEN', Date.now(), Date.now());
  }

  getOpenQuests(campaignId: string): Quest[] {
      return this.dbService.getDb().prepare(
          'SELECT * FROM quests WHERE campaign_id = ? AND status = \'OPEN\''
      ).all(campaignId) as Quest[];
  }

  updateQuestStatus(campaignId: string, titleSearch: string, status: string): boolean {
      const result = this.dbService.getDb().prepare(
          'UPDATE quests SET status = ?, updated_at = ? WHERE campaign_id = ? AND title LIKE ?'
      ).run(status, Date.now(), campaignId, `%${titleSearch}%`);
      return result.changes > 0;
  }

  // --- Inventory (Loot) ---
  addLoot(campaignId: string, item: string, quantity: number = 1): void {
      const exists = this.dbService.getDb().prepare(
          'SELECT id, quantity FROM inventory WHERE campaign_id = ? AND item_name = ?'
      ).get(campaignId, item) as { id: number, quantity: number } | undefined;

      if (exists) {
          this.dbService.getDb().prepare(
              'UPDATE inventory SET quantity = quantity + ? WHERE id = ?'
          ).run(quantity, exists.id);
      } else {
          this.dbService.getDb().prepare(
              'INSERT INTO inventory (campaign_id, item_name, quantity, added_at) VALUES (?, ?, ?, ?)'
          ).run(campaignId, item, quantity, Date.now());
      }
  }

  removeLoot(campaignId: string, itemSearch: string, quantity: number = 1): boolean {
      const exists = this.dbService.getDb().prepare(
          'SELECT id, quantity FROM inventory WHERE campaign_id = ? AND item_name LIKE ?'
      ).get(campaignId, `%${itemSearch}%`) as { id: number, quantity: number } | undefined;

      if (!exists) return false;

      if (exists.quantity <= quantity) {
          this.dbService.getDb().prepare('DELETE FROM inventory WHERE id = ?').run(exists.id);
      } else {
          this.dbService.getDb().prepare('UPDATE inventory SET quantity = quantity - ? WHERE id = ?').run(quantity, exists.id);
      }
      return true;
  }

  getInventory(campaignId: string): InventoryItem[] {
      return this.dbService.getDb().prepare(
          'SELECT * FROM inventory WHERE campaign_id = ? ORDER BY item_name ASC'
      ).all(campaignId) as InventoryItem[];
  }
}
