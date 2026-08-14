import { db } from '../client';
import { Campaign, CampaignSnapshot, LocationState } from '../types';
import { drawTarotArcanum, type TarotArcanum } from '../../services/tarotArcana';

export const campaignRepository = {
    createCampaign: (guildId: string, name: string): number => {
        // The card is drawn once, here: a campaign arrives on the shelf already
        // showing an arcanum, and the table changes it later if it wants to.
        const info = db.prepare(
            'INSERT INTO campaigns (guild_id, name, created_at, tarot_arcana) VALUES (?, ?, ?, ?)',
        ).run(guildId, name, Date.now(), drawTarotArcanum());
        return info.lastInsertRowid as number;
    },

    getCampaigns: (guildId: string): Campaign[] => {
        return db.prepare('SELECT * FROM campaigns WHERE guild_id = ? ORDER BY created_at DESC').all(guildId) as Campaign[];
    },

    getActiveCampaign: (guildId: string): Campaign | undefined => {
        return db.prepare('SELECT * FROM campaigns WHERE guild_id = ? AND is_active = 1').get(guildId) as Campaign | undefined;
    },

    setCampaignLanguage: (campaignId: number, language: string | null): void => {
        db.prepare('UPDATE campaigns SET language = ? WHERE id = ?').run(language, campaignId);
    },

    /**
     * The house style for this table's generated pictures.
     *
     * Empty string and null mean the same thing here — «no preference» — so a
     * cleared textarea restores the built-in default instead of sending an
     * empty style line to the model.
     */
    setCampaignArtDirection: (campaignId: number, artDirection: string | null): void => {
        const value = artDirection?.trim() ? artDirection.trim() : null;
        db.prepare('UPDATE campaigns SET art_direction = ? WHERE id = ?').run(value, campaignId);
    },

    /**
     * The picture on the campaign's card.
     *
     * Both variants move together: a display object without its thumbnail would
     * leave the card asking the browser to shrink a 1600px picture into a
     * medallion the size of a coin.
     */
    setCampaignCover: (campaignId: number, objectKey: string, thumbnailKey: string): void => {
        db.prepare(
            'UPDATE campaigns SET cover_object_key = ?, cover_thumbnail_key = ?, cover_updated_at = ? WHERE id = ?',
        ).run(objectKey, thumbnailKey, Date.now(), campaignId);
    },

    clearCampaignCover: (campaignId: number): void => {
        db.prepare(
            'UPDATE campaigns SET cover_object_key = NULL, cover_thumbnail_key = NULL, cover_updated_at = NULL WHERE id = ?',
        ).run(campaignId);
    },

    setCampaignTarotArcanum: (campaignId: number, arcanum: TarotArcanum): void => {
        db.prepare('UPDATE campaigns SET tarot_arcana = ? WHERE id = ?').run(arcanum, campaignId);
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

    renameCampaign: (campaignId: number, name: string): void => {
        db.prepare('UPDATE campaigns SET name = ? WHERE id = ?').run(name, campaignId);
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

    /**
     * Deletes a campaign and every row that belonged to it.
     *
     * This used to be a lone `DELETE FROM campaigns`, trusting cascades that do
     * not exist. Two tables never followed the campaign down:
     *
     *  - **`recordings`** has no foreign key at all, so the per-user audio rows
     *    and their `transcription_text` outlived the campaign indefinitely;
     *  - **`sessions.campaign_id` is `ON DELETE SET NULL`**, so sessions
     *    survived as orphans — taking `session_logs` and `session_notes` with
     *    them, since those hang off the session rather than the campaign.
     *
     * The result was that deleting a campaign left the most personal data it
     * held — what people actually said — sitting in the database, attributable
     * to a Discord user id but attached to nothing anyone could find.
     *
     * Objects in the bucket are **not** touched here: this is the database
     * layer. `services/dataErasure.ts#eraseCampaignData` wraps this call with
     * the storage sweep, and is what the command uses.
     */
    deleteCampaign: (campaignId: number) => {
        db.transaction(() => {
            const sessionIds = db.prepare('SELECT session_id FROM sessions WHERE campaign_id = ?')
                .all(campaignId)
                .map(r => (r as { session_id: string }).session_id);

            if (sessionIds.length > 0) {
                const placeholders = sessionIds.map(() => '?').join(',');
                db.prepare(`DELETE FROM recordings WHERE session_id IN (${placeholders})`).run(...sessionIds);
                db.prepare(`DELETE FROM session_notes WHERE session_id IN (${placeholders})`).run(...sessionIds);
                // session_logs cascades from sessions.
                db.prepare(`DELETE FROM sessions WHERE session_id IN (${placeholders})`).run(...sessionIds);
            }

            db.prepare('DELETE FROM ai_usage_log WHERE campaign_id = ?').run(campaignId);
            // The campaign row cascades into characters, members, quests,
            // inventory, RAG fragments, entity media, the ask threads and every
            // *_history table (foreign_keys is ON in db/client.ts).
            db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId);
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
    },

    updatePartyAlignment: (campaignId: number, moral?: string, ethical?: string): void => {
        if (!moral && !ethical) return;

        const updates: string[] = [];
        const params: any[] = [];

        if (moral) {
            updates.push('party_alignment_moral = ?');
            params.push(moral);
        }
        if (ethical) {
            updates.push('party_alignment_ethical = ?');
            params.push(ethical);
        }

        params.push(campaignId);

        db.prepare(`UPDATE campaigns SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        console.log(`[DB] ⚖️ Allineamento Party aggiornato: ${moral || '-'} / ${ethical || '-'}`);
    }
};
