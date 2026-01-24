import { db } from '../client';
import { Campaign, CampaignSnapshot, LocationState } from '../types';

export const campaignRepository = {
    createCampaign: (guildId: string, name: string): number => {
        const info = db.prepare('INSERT INTO campaigns (guild_id, name, created_at) VALUES (?, ?, ?)').run(guildId, name, Date.now());
        return info.lastInsertRowid as number;
    },

    getCampaigns: (guildId: string): Campaign[] => {
        return db.prepare('SELECT * FROM campaigns WHERE guild_id = ? ORDER BY created_at DESC').all(guildId) as Campaign[];
    },

    getActiveCampaign: (guildId: string): Campaign | undefined => {
        return db.prepare('SELECT * FROM campaigns WHERE guild_id = ? AND is_active = 1').get(guildId) as Campaign | undefined;
    },

    setActiveCampaign: (guildId: string, campaignId: number): void => {
        db.transaction(() => {
            db.prepare('UPDATE campaigns SET is_active = 0 WHERE guild_id = ?').run(guildId);
            db.prepare('UPDATE campaigns SET is_active = 1 WHERE id = ? AND guild_id = ?').run(campaignId, guildId);
        })();
    },

    updateCampaignLocation: (guildId: string, location: string): void => {
        const campaign = campaignRepository.getActiveCampaign(guildId);
        if (campaign) {
            db.transaction(() => {
                db.prepare('UPDATE campaigns SET current_location = ? WHERE id = ?').run(location, campaign.id);
                db.prepare('INSERT INTO location_history (campaign_id, location, timestamp) VALUES (?, ?, ?)').run(campaign.id, location, Date.now());
            })();
        }
    },

    setCampaignYear: (campaignId: number, year: number): void => {
        db.prepare('UPDATE campaigns SET current_year = ? WHERE id = ?').run(year, campaignId);
        console.log(`[DB] 📅 Anno campagna ${campaignId} impostato a: ${year}`);
    },

    setCampaignAutoUpdate: (campaignId: number, allow: boolean): void => {
        db.prepare('UPDATE campaigns SET allow_auto_character_update = ? WHERE id = ?').run(allow ? 1 : 0, campaignId);
        console.log(`[DB] ⚙️ Auto-update PG per campagna ${campaignId}: ${allow}`);
    },

    getCampaignLocation: (guildId: string): LocationState | null => {
        const row = db.prepare(`
            SELECT current_macro_location as macro, current_micro_location as micro 
            FROM campaigns 
            WHERE guild_id = ? AND is_active = 1
        `).get(guildId) as LocationState | undefined;
        return row || null;
    },

    getCampaignLocationById: (campaignId: number): LocationState | null => {
        const row = db.prepare(`
            SELECT current_macro_location as macro, current_micro_location as micro 
            FROM campaigns 
            WHERE id = ?
        `).get(campaignId) as LocationState | undefined;
        return row || null;
    },

    getCampaignById: (id: number): Campaign | undefined => {
        return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as Campaign | undefined;
    },

    deleteCampaign: (campaignId: number) => {
        db.transaction(() => {
            db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId);
            // Cascade delete handles most sub-tables, but we might want explicit cleanup if needed
            // SQLite foreign keys with ON DELETE CASCADE should handle: 
            // characters, character_history, npc_history, world_history, 
            // sessions (set null), knowledge_fragments, location_history, 
            // npc_dossier (no FK? check schema), quests, bestiary, inventory
        })();
    },

    getCampaignSnapshot: (campaignId: number): CampaignSnapshot => {
        // This function requires access to other repositories (characters, quests, atlas)
        // For now, I will implement a placeholder or move this logic to a service later.
        // Or I can query the tables directly here since it's "raw" data access.

        // Let's implement querying directly for now to avoid circular dependencies between repositories

        // Checking schema.ts: 'characters' table exists. 
        // The original logic used `getCampaignCharacters`, which joins proper tables.
        // It's safer to defer implementation of `getCampaignSnapshot` until CharacterRepository is ready, 
        // BUT `getCampaignSnapshot` returns a `CampaignSnapshot` object.
        // Use direct SQL here to keep it self-contained in repository layer.

        const chars = db.prepare(`
            SELECT u.user_id, u.character_name, u.race, u.class, u.description
            FROM characters u
            WHERE u.campaign_id = ?
        `).all(campaignId);

        const openQuests = db.prepare(`
            SELECT title, status FROM quests WHERE campaign_id = ? AND status = 'OPEN'
        `).all(campaignId);

        const location = campaignRepository.getCampaignLocationById(campaignId);

        let atlasDesc: string | null = null;
        if (location && location.macro && location.micro) {
            const row = db.prepare(`
                SELECT description FROM location_atlas 
                WHERE campaign_id = ? 
                AND lower(macro_location) = lower(?) 
                AND lower(micro_location) = lower(?)
            `).get(campaignId, location.macro, location.micro) as { description: string } | undefined;
            atlasDesc = row?.description || null;
        }

        // Context strings construction (legacy/helper)
        const pcContext = chars.map((c: any) => `${c.character_name} (${c.race} ${c.class}): ${c.description || 'N/A'}`).join('\n');
        const questContext = openQuests.map((q: any) => `- ${q.title}`).join('\n');
        const locContext = location ? `${location.macro} - ${location.micro}` : "Unknown";

        return {
            characters: chars,
            quests: openQuests,
            location,
            macro: location?.macro || null,
            micro: location?.micro || null,
            atlasDesc,
            pc_context: pcContext,
            quest_context: questContext,
            location_context: locContext
        };
    },

    /**
     * Gets the next session number for a campaign (intelligent auto-increment)
     * Uses MAX of: last_session_number from campaigns, or highest session_number from sessions table
     */
    getNextSessionNumber: (campaignId: number): number => {
        // Get last_session_number from campaigns table
        const campaignRow = db.prepare('SELECT last_session_number FROM campaigns WHERE id = ?').get(campaignId) as { last_session_number: number } | undefined;
        const fromCampaign = campaignRow?.last_session_number || 0;

        // Get MAX session_number from sessions for this campaign
        const sessionRow = db.prepare('SELECT MAX(session_number) as max_num FROM sessions WHERE campaign_id = ?').get(campaignId) as { max_num: number } | undefined;
        const fromSessions = sessionRow?.max_num || 0;

        // Use the highest value + 1
        const nextNumber = Math.max(fromCampaign, fromSessions) + 1;
        console.log(`[SessionCounter] 📊 Campagna ${campaignId}: next=${nextNumber} (fromCampaign=${fromCampaign}, fromSessions=${fromSessions})`);
        return nextNumber;
    },

    /**
     * Updates the last_session_number for a campaign
     */
    updateLastSessionNumber: (campaignId: number, sessionNumber: number): void => {
        db.prepare('UPDATE campaigns SET last_session_number = ? WHERE id = ?').run(sessionNumber, campaignId);
    }
};
