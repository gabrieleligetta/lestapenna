import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { Campaign, NpcDossier, NpcHistory, LocationHistory, LocationAtlas, Quest } from '../database/types';

export interface LocationState {
    macro: string | null;
    micro: string | null;
}

@Injectable()
export class CampaignRepository {
  constructor(private readonly dbService: DatabaseService) {}

  create(guildId: string, name: string): number {
    const res = this.dbService.getDb().prepare(
      'INSERT INTO campaigns (guild_id, name, created_at, is_active) VALUES (?, ?, ?, 1)'
    ).run(guildId, name, Date.now());
    return res.lastInsertRowid as number;
  }

  findAll(guildId: string): Campaign[] {
    return this.dbService.getDb().prepare(
      'SELECT * FROM campaigns WHERE guild_id = ?'
    ).all(guildId) as Campaign[];
  }

  findActive(guildId: string): Campaign | undefined {
    return this.dbService.getDb().prepare(
      'SELECT * FROM campaigns WHERE guild_id = ? AND is_active = 1'
    ).get(guildId) as Campaign | undefined;
  }

  findById(id: number | null): Campaign | undefined {
    return this.dbService.getDb().prepare(
      'SELECT * FROM campaigns WHERE id = ?'
    ).get(id) as Campaign | undefined;
  }

  setActive(guildId: string, campaignId: number): void {
    const db = this.dbService.getDb();
    db.transaction(() => {
      db.prepare('UPDATE campaigns SET is_active = 0 WHERE guild_id = ?').run(guildId);
      db.prepare('UPDATE campaigns SET is_active = 1 WHERE id = ?').run(campaignId);
    })();
  }

  setYear(campaignId: number, year: number): void {
    this.dbService.getDb().prepare(
      'UPDATE campaigns SET current_year = ? WHERE id = ?'
    ).run(year, campaignId);
  }

  // --- NUOVI METODI PER AI ---
  getAllNpcs(campaignId: number | null): NpcDossier[] {
      try {
          return this.dbService.getDb().prepare('SELECT * FROM npc_dossier WHERE campaign_id = ?').all(campaignId) as NpcDossier[];
      } catch (e) {
          return [];
      }
  }

  getNpcHistory(campaignId: number, npcName: string): NpcHistory[] {
      try {
          return this.dbService.getDb().prepare(
              'SELECT * FROM npc_history WHERE campaign_id = ? AND npc_name = ? ORDER BY timestamp ASC'
          ).all(campaignId, npcName) as NpcHistory[];
      } catch (e) {
          return [];
      }
  }

  getCurrentLocation(campaignId: number): LocationState {
      try {
          // Cerca l'ultima location history
          const loc = this.dbService.getDb().prepare(
              'SELECT macro_location, micro_location FROM location_history WHERE campaign_id = ? ORDER BY timestamp DESC LIMIT 1'
          ).get(campaignId) as LocationHistory;
          
          return { macro: loc?.macro_location || null, micro: loc?.micro_location || null };
      } catch (e) {
          return { macro: null, micro: null };
      }
  }

  getAtlasEntry(campaignId: number, macro: string, micro: string): string | null {
      try {
          const entry = this.dbService.getDb().prepare(
              'SELECT description FROM location_atlas WHERE campaign_id = ? AND macro_location = ? AND micro_location = ?'
          ).get(campaignId, macro, micro) as LocationAtlas;
          return entry?.description || null;
      } catch (e) {
          return null;
      }
  }

  getQuests(campaignId: number): Quest[] {
      try {
          return this.dbService.getDb().prepare('SELECT * FROM quests WHERE campaign_id = ? AND status = "OPEN"').all(campaignId) as Quest[];
      } catch (e) {
          return [];
      }
  }
  // ---------------------------

  delete(id: number): void {
    const db = this.dbService.getDb();
    
    db.transaction(() => {
        // 1. Trova sessioni
        try {
            const sessions = db.prepare('SELECT session_id FROM sessions WHERE campaign_id = ?').all(id) as { session_id: string }[];

            const deleteRec = db.prepare('DELETE FROM recordings WHERE session_id = ?');
            const deleteSess = db.prepare('DELETE FROM sessions WHERE session_id = ?');
            const deleteNotes = db.prepare('DELETE FROM session_notes WHERE session_id = ?');

            for (const s of sessions) {
                try { deleteRec.run(s.session_id); } catch(e) {}
                try { deleteNotes.run(s.session_id); } catch(e) {}
                try { deleteSess.run(s.session_id); } catch(e) {}
            }
        } catch (e) {}

        // --- PULIZIA MANUALE TABELLE ORFANE ---
        const tables = [
            'location_history', 
            'location_atlas', 
            'npc_dossier', 
            'quests', 
            'inventory', 
            'character_history', 
            'npc_history', 
            'world_history',
            'knowledge_fragments'
        ];

        for (const table of tables) {
            try {
                db.prepare(`DELETE FROM ${table} WHERE campaign_id = ?`).run(id);
            } catch (e) {}
        }

        // 3. Elimina campagna
        db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
    })();
  }
}
