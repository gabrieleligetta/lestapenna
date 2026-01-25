import { db } from '../client';
import { AtlasEntryFull } from '../types';
import { campaignRepository } from './CampaignRepository';

export const locationRepository = {
    updateLocation: (campaignId: number, macro: string | null, micro: string | null, sessionId?: string): void => {
        // 1. Aggiorna lo stato corrente della campagna
        const current = campaignRepository.getCampaignLocationById(campaignId);

        // Se è identico, non facciamo nulla (evita spam nella history)
        if (current && current.macro === macro && current.micro === micro) return;

        const stmt = db.prepare(`
            UPDATE campaigns 
            SET current_macro_location = COALESCE(?, current_macro_location), 
                current_micro_location = ? 
            WHERE id = ?
        `);
        // Nota: Micro può essere resettato, Macro tendiamo a mantenerlo se non specificato
        stmt.run(macro, micro, campaignId);

        // 2. Aggiungi alla cronologia
        let legacyLocation = "Sconosciuto";
        if (macro && micro) legacyLocation = `${macro} | ${micro}`;
        else if (macro) legacyLocation = macro;
        else if (micro) legacyLocation = micro;

        const historyStmt = db.prepare(`
            INSERT INTO location_history (campaign_id, location, macro_location, micro_location, session_date, timestamp, session_id)
            VALUES (?, ?, ?, ?, date('now'), ?, ?)
        `);
        historyStmt.run(campaignId, legacyLocation, macro, micro, Date.now(), sessionId || null);

        console.log(`[DB] 🗺️ Luogo aggiornato: [${macro}] - (${micro})`);
    },

    getLocationHistory: (guildId: string) => {
        return db.prepare(`
            SELECT h.macro_location, h.micro_location, h.timestamp, h.session_date 
            FROM location_history h
            JOIN campaigns c ON h.campaign_id = c.id
            WHERE c.guild_id = ? AND c.is_active = 1
            ORDER BY h.timestamp DESC
            LIMIT 20
        `).all(guildId);
    },

    getAtlasEntry: (campaignId: number, macro: string, micro: string): string | null => {
        // Normalizziamo le stringhe per evitare duplicati "Taverna" vs "taverna"
        const row = db.prepare(`
            SELECT description FROM location_atlas 
            WHERE campaign_id = ? 
            AND lower(macro_location) = lower(?) 
            AND lower(micro_location) = lower(?)
        `).get(campaignId, macro, micro) as { description: string } | undefined;

        return row ? row.description : null;
    },

    updateAtlasEntry: (campaignId: number, macro: string, micro: string, newDescription: string, sessionId?: string) => {
        // Sanitize
        const safeDesc = (typeof newDescription === 'object') ? JSON.stringify(newDescription) : String(newDescription);

        // IMPORTANTE: last_updated_session_id traccia chi ha modificato per ultimo (per purge pulito)
        db.prepare(`
            INSERT INTO location_atlas (campaign_id, macro_location, micro_location, description, last_updated, first_session_id, last_updated_session_id, rag_sync_needed)
            VALUES ($campaignId, $macro, $micro, $desc, CURRENT_TIMESTAMP, $sessionId, $sessionId, 1)
            ON CONFLICT(campaign_id, macro_location, micro_location)
            DO UPDATE SET description = $desc, last_updated = CURRENT_TIMESTAMP, last_updated_session_id = $sessionId, rag_sync_needed = 1
        `).run({ campaignId, macro, micro, desc: safeDesc, sessionId: sessionId || null });

        console.log(`[Atlas] 📖 Aggiornata voce per: ${macro} - ${micro}`);
    },

    listAtlasEntries: (campaignId: number, limit: number = 15, offset: number = 0): any[] => {
        return db.prepare(`
            SELECT id, macro_location, micro_location, description, last_updated
            FROM location_atlas
            WHERE campaign_id = ?
            ORDER BY last_updated DESC
            LIMIT ? OFFSET ?
        `).all(campaignId, limit, offset);
    },

    countAtlasEntries: (campaignId: number): number => {
        const result = db.prepare('SELECT COUNT(*) as count FROM location_atlas WHERE campaign_id = ?').get(campaignId) as { count: number };
        return result.count;
    },

    listAllAtlasEntries: (campaignId: number): any[] => {
        return db.prepare(`
            SELECT id, macro_location, micro_location, description, last_updated
            FROM location_atlas
            WHERE campaign_id = ?
            ORDER BY last_updated DESC
        `).all(campaignId);
    },

    deleteAtlasEntry: (campaignId: number, macro: string, micro: string): boolean => {
        const result = db.prepare(`
            DELETE FROM location_atlas
            WHERE campaign_id = ?
              AND lower(macro_location) = lower(?)
              AND lower(micro_location) = lower(?)
        `).run(campaignId, macro, micro);

        if (result.changes > 0) {
            console.log(`[Atlas] 🗑️ Eliminata voce: ${macro} - ${micro}`);
            return true;
        }
        return false;
    },

    deleteAtlasHistory: (campaignId: number, macro: string, micro: string): boolean => {
        const result = db.prepare(`
            DELETE FROM location_history
            WHERE campaign_id = ?
              AND lower(macro_location) = lower(?)
              AND lower(micro_location) = lower(?)
        `).run(campaignId, macro, micro);
        return result.changes > 0;
    },

    getAtlasEntryFull: (campaignId: number, macro: string, micro: string): any | null => {
        return db.prepare(`
            SELECT id, macro_location, micro_location, description, last_updated
            FROM location_atlas
            WHERE campaign_id = ?
              AND lower(macro_location) = lower(?)
              AND lower(micro_location) = lower(?)
        `).get(campaignId, macro, micro) || null;
    },

    renameAtlasEntry: (
        campaignId: number,
        oldMacro: string,
        oldMicro: string,
        newMacro: string,
        newMicro: string,
        updateHistory: boolean = false
    ): boolean => {
        const existing = locationRepository.getAtlasEntryFull(campaignId, oldMacro, oldMicro);
        if (!existing) return false;

        const conflict = locationRepository.getAtlasEntryFull(campaignId, newMacro, newMicro);
        if (conflict) {
            console.error(`[Atlas] ⚠️ Destinazione ${newMacro} - ${newMicro} esiste già!`);
            return false;
        }

        db.transaction(() => {
            db.prepare(`
                UPDATE location_atlas
                SET macro_location = ?, micro_location = ?, last_updated = CURRENT_TIMESTAMP, rag_sync_needed = 1
                WHERE id = ?
            `).run(newMacro, newMicro, existing.id);

            if (updateHistory) {
                db.prepare(`
                    UPDATE location_history
                    SET macro_location = ?, micro_location = ?,
                        location = ? || ' | ' || ?
                    WHERE campaign_id = ?
                      AND lower(macro_location) = lower(?)
                      AND lower(micro_location) = lower(?)
                `).run(newMacro, newMicro, newMacro, newMicro, campaignId, oldMacro, oldMicro);
            }
        })();

        console.log(`[Atlas] 🔄 Rinominato: ${oldMacro} - ${oldMicro} -> ${newMacro} - ${newMicro}`);
        return true;
    },

    mergeAtlasEntry: (
        campaignId: number,
        oldMacro: string,
        oldMicro: string,
        newMacro: string,
        newMicro: string,
        mergedDescription: string
    ): boolean => {
        const source = locationRepository.getAtlasEntryFull(campaignId, oldMacro, oldMicro);
        const target = locationRepository.getAtlasEntryFull(campaignId, newMacro, newMicro);

        if (!source || !target) return false;

        db.transaction(() => {
            db.prepare(`
                UPDATE location_atlas
                SET description = ?, last_updated = CURRENT_TIMESTAMP, rag_sync_needed = 1
                WHERE id = ?
            `).run(mergedDescription, target.id);

            db.prepare(`
                UPDATE location_history
                SET macro_location = ?, micro_location = ?,
                    location = ? || ' | ' || ?
                WHERE campaign_id = ?
                  AND lower(macro_location) = lower(?)
                  AND lower(micro_location) = lower(?)
            `).run(newMacro, newMicro, newMacro, newMicro, campaignId, oldMacro, oldMicro);

            db.prepare(`DELETE FROM location_atlas WHERE id = ?`).run(source.id);
        })();

        console.log(`[Atlas] 🔀 Merged: ${oldMacro} - ${oldMicro} -> ${newMacro} - ${newMicro}`);
        return true;
    },

    getLocationHistoryWithIds: (campaignId: number, limit: number = 20): any[] => {
        return db.prepare(`
            SELECT id, macro_location, micro_location, timestamp, session_date, session_id
            FROM location_history
            WHERE campaign_id = ?
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(campaignId, limit);
    },

    fixLocationHistoryEntry: (entryId: number, newMacro: string, newMicro: string): boolean => {
        const result = db.prepare(`
            UPDATE location_history
            SET macro_location = ?, micro_location = ?,
                location = ? || ' | ' || ?
            WHERE id = ?
        `).run(newMacro, newMicro, newMacro, newMicro, entryId);
        return result.changes > 0;
    },

    deleteLocationHistoryEntry: (id: number): boolean => {
        const result = db.prepare('DELETE FROM location_history WHERE id = ?').run(id);
        return result.changes > 0;
    },

    fixCurrentLocation: (campaignId: number, newMacro: string, newMicro: string): void => {
        db.prepare(`
            UPDATE campaigns 
            SET current_macro_location = ?, current_micro_location = ? 
            WHERE id = ?
        `).run(newMacro, newMicro, campaignId);
    },

    getDirtyAtlasEntries: (campaignId: number): AtlasEntryFull[] => {
        return db.prepare(`
            SELECT * FROM location_atlas
            WHERE campaign_id = ? AND rag_sync_needed = 1
        `).all(campaignId) as AtlasEntryFull[];
    },

    clearAtlasDirtyFlag: (campaignId: number, macro: string, micro: string): void => {
        db.prepare(`
            UPDATE location_atlas 
            SET rag_sync_needed = 0 
            WHERE campaign_id = ? AND macro_location = ? AND micro_location = ?
        `).run(campaignId, macro, micro);
    },

    markAtlasDirty: (campaignId: number, macro: string, micro: string): void => {
        db.prepare(`
            UPDATE location_atlas 
            SET rag_sync_needed = 1 
            WHERE campaign_id = ? AND macro_location = ? AND micro_location = ?
        `).run(campaignId, macro, micro);
    },

    getSessionTravelLog: (sessionId: string): { macro_location: string; micro_location: string; timestamp: number }[] => {
        return db.prepare(`
            SELECT macro_location, micro_location, timestamp
            FROM location_history
            WHERE session_id = ?
            ORDER BY timestamp ASC
        `).all(sessionId) as { macro_location: string; micro_location: string; timestamp: number }[];
    },

    // 🆕 UNIFIED BIO FLOW
    addAtlasEvent: (campaignId: number, macro: string, micro: string, sessionId: string | null, description: string, type: string) => {
        db.prepare(`
            INSERT INTO atlas_history (campaign_id, macro_location, micro_location, session_id, description, event_type, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(campaignId, macro, micro, sessionId, description, type, Date.now());
    },

    getAtlasHistory: (campaignId: number, macro: string, micro: string): { description: string, event_type: string, session_id: string }[] => {
        return db.prepare(`
            SELECT description, event_type, session_id 
            FROM atlas_history 
            WHERE campaign_id = ? 
            AND lower(macro_location) = lower(?) 
            AND lower(micro_location) = lower(?)
            ORDER BY timestamp ASC
        `).all(campaignId, macro, micro) as { description: string, event_type: string, session_id: string }[];
    }
};
