import { db } from '../client';
import { UserProfile } from '../types';

export const characterRepository = {
    addCharacterEvent: (campaignId: number, charName: string, sessionId: string, description: string, type: string, isManual: boolean = false, timestamp?: number) => {
        db.prepare(`
            INSERT INTO character_history (campaign_id, character_name, session_id, description, event_type, timestamp, is_manual)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(campaignId, charName, sessionId, description, type, timestamp || Date.now(), isManual ? 1 : 0);
    },

    getCharacterHistory: (campaignId: number, charName: string): { description: string, event_type: string, session_id: string }[] => {
        return db.prepare(`
            SELECT description, event_type, session_id 
            FROM character_history 
            WHERE campaign_id = ? AND character_name = ?
            ORDER BY timestamp ASC
        `).all(campaignId, charName) as { description: string, event_type: string, session_id: string }[];
    },

    getNewCharacterHistory: (
        campaignId: number,
        charName: string,
        lastSyncedId: number
    ): { events: { id: number, description: string, event_type: string, session_id: string }[], maxId: number } => {
        const events = db.prepare(`
            SELECT id, description, event_type, session_id 
            FROM character_history 
            WHERE campaign_id = ? AND character_name = ? AND id > ?
            ORDER BY id ASC
        `).all(campaignId, charName, lastSyncedId) as { id: number, description: string, event_type: string, session_id: string }[];

        const maxId = events.length > 0 ? events[events.length - 1].id : lastSyncedId;

        return { events, maxId };
    },

    updateCharacterLastSyncedHistoryId: (userId: string, campaignId: number, historyId: number): void => {
        db.prepare(`
            UPDATE characters 
            SET last_synced_history_id = ?, rag_sync_needed = 0
            WHERE user_id = ? AND campaign_id = ?
        `).run(historyId, userId, campaignId);
    },

    getCharacterUserId: (campaignId: number, characterName: string): string | null => {
        const row = db.prepare(`
            SELECT user_id FROM characters WHERE campaign_id = ? AND lower(character_name) = lower(?)
        `).get(campaignId, characterName) as { user_id: string } | undefined;
        return row ? row.user_id : null;
    },

    getUserProfile: (userId: string, campaignId: number): UserProfile & { foundation_description: string | null } => {
        const row = db.prepare('SELECT character_name, race, class, description, foundation_description, alignment_moral, alignment_ethical FROM characters WHERE user_id = ? AND campaign_id = ?').get(userId, campaignId) as any | undefined;
        return row || { character_name: null, race: null, class: null, description: null, foundation_description: null };
    },

    getUserName: (userId: string, campaignId: number): string | null => {
        const profile = characterRepository.getUserProfile(userId, campaignId);
        return profile.character_name;
    },

    getCampaignCharacters: (campaignId: number): (UserProfile & { user_id: string, foundation_description: string | null })[] => {
        return db.prepare('SELECT user_id, character_name, race, class, description, foundation_description FROM characters WHERE campaign_id = ?').all(campaignId) as any[];
    },

    updateUserCharacter: (userId: string, campaignId: number, field: 'character_name' | 'race' | 'class' | 'description' | 'foundation_description', value: string, isManual: boolean = true): void => {
        // Upsert character profile
        const exists = db.prepare('SELECT 1 FROM characters WHERE user_id = ? AND campaign_id = ?').get(userId, campaignId);

        if (exists) {
            let sql = `UPDATE characters SET ${field} = ?, rag_sync_needed = 1`;
            if (isManual) sql += `, is_manual = 1`;
            sql += ` WHERE user_id = ? AND campaign_id = ?`;
            db.prepare(sql).run(value, userId, campaignId);
        } else {
            // Create new with just this field populated
            db.prepare(`INSERT INTO characters (user_id, campaign_id, ${field}, rag_sync_needed, is_manual) VALUES (?, ?, ?, 1, ?)`).run(userId, campaignId, value, isManual ? 1 : 0);
        }
    },

    updateFoundationDescription: (userId: string, campaignId: number, value: string): void => {
        characterRepository.updateUserCharacter(userId, campaignId, 'foundation_description', value, true);
    },

    deleteUserCharacter: (userId: string, campaignId: number) => {
        db.prepare('DELETE FROM characters WHERE user_id = ? AND campaign_id = ?').run(userId, campaignId);
    },

    markCharacterDirtyByName: (campaignId: number, characterName: string): void => {
        db.prepare(`
             UPDATE characters 
             SET rag_sync_needed = 1 
             WHERE campaign_id = ? AND lower(character_name) = lower(?)
         `).run(campaignId, characterName);
    },

    getDirtyCharacters: (campaignId: number): any[] => {
        return db.prepare(`
            SELECT * FROM characters 
            WHERE campaign_id = ? AND rag_sync_needed = 1
        `).all(campaignId);
    },

    markCharacterDirty: (campaignId: number, userId: string): void => {
        db.prepare(`
             UPDATE characters 
             SET rag_sync_needed = 1 
             WHERE campaign_id = ? AND user_id = ?
         `).run(campaignId, userId);
    },

    clearCharacterDirtyFlag: (campaignId: number, userId: string): void => {
        db.prepare(`
             UPDATE characters 
             SET rag_sync_needed = 0 
             WHERE campaign_id = ? AND user_id = ?
         `).run(campaignId, userId);
    },

    updateCharacterAlignment: (campaignId: number, characterName: string, moral?: string, ethical?: string): void => {
        const userId = characterRepository.getCharacterUserId(campaignId, characterName);
        if (!userId) {
            console.log(`[DB] ⚠️ Impossibile aggiornare allineamento per PG sconosciuto: ${characterName}`);
            return;
        }

        const updates: string[] = [];
        const params: any[] = [];

        if (moral) {
            updates.push('alignment_moral = ?');
            params.push(moral);
        }
        if (ethical) {
            updates.push('alignment_ethical = ?');
            params.push(ethical);
        }

        if (updates.length === 0) return;

        updates.push('rag_sync_needed = 1');

        params.push(userId);
        params.push(campaignId);

        db.prepare(`UPDATE characters SET ${updates.join(', ')} WHERE user_id = ? AND campaign_id = ?`).run(...params);
        console.log(`[DB] ⚖️ Allineamento PG ${characterName} aggiornato: ${moral || '-'} / ${ethical || '-'}`);
    }
};
