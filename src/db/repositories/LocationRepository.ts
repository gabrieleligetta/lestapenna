import { db } from '../client';
import { AtlasEntryFull } from '../types';
import { campaignRepository } from './CampaignRepository';
import { generateShortId } from '../utils/idGenerator';

export const locationRepository = {
    updateLocation: (campaignId: number, macro: string | null, micro: string | null, sessionId?: string, reason?: string, timestamp?: number, isManual: boolean = false): void => {
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

        const effectiveTimestamp = timestamp || Date.now();
        const sessionDateString = new Date(effectiveTimestamp).toISOString().split('T')[0];

        const historyStmt = db.prepare(`
            INSERT INTO location_history (campaign_id, location, macro_location, micro_location, session_id, reason, timestamp, session_date, is_manual)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        historyStmt.run(campaignId, legacyLocation, macro, micro, sessionId || null, reason || null, effectiveTimestamp, sessionDateString, isManual ? 1 : 0);

        console.log(`[DB] 🗺️ Luogo aggiornato: [${macro}] - (${micro})`);
    },

    getLocationHistory: (guildId: string) => {
        return db.prepare(`
            SELECT h.macro_location, h.micro_location, h.timestamp, h.session_date, s.session_number 
            FROM location_history h
            JOIN campaigns c ON h.campaign_id = c.id
            LEFT JOIN sessions s ON h.session_id = s.session_id
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

    updateAtlasEntry: (campaignId: number, macro: string, micro: string, newDescription: string, sessionId?: string, isManual: boolean = false) => {
        // Sanitize
        const safeDesc = (typeof newDescription === 'object') ? JSON.stringify(newDescription) : String(newDescription);

        if (!safeDesc || safeDesc.trim().length === 0) {
            console.warn(`[Atlas] ⚠️ Attenzione: Aggiornamento voce ${macro} - ${micro} con descrizione vuota.`);
        }

        // Check if exists to determine if we need a new short_id
        const existing = locationRepository.getAtlasEntryFull(campaignId, macro, micro);
        const shortId = existing?.short_id || generateShortId('location_atlas');

        // IMPORTANTE: last_updated_session_id traccia chi ha modificato per ultimo (per purge pulito)
        db.prepare(`
            INSERT INTO location_atlas (campaign_id, macro_location, micro_location, description, last_updated, first_session_id, last_updated_session_id, rag_sync_needed, is_manual, short_id)
            VALUES ($campaignId, $macro, $micro, $desc, CURRENT_TIMESTAMP, $sessionId, $sessionId, 1, $isManual, $shortId)
            ON CONFLICT(campaign_id, macro_location, micro_location)
            DO UPDATE SET description = $desc, last_updated = CURRENT_TIMESTAMP, last_updated_session_id = $sessionId, rag_sync_needed = 1, is_manual = CASE WHEN $isManual = 1 THEN 1 ELSE is_manual END
        `).run({ campaignId, macro, micro, desc: safeDesc, sessionId: sessionId || null, isManual: isManual ? 1 : 0, shortId });

        console.log(`[Atlas] 📖 Aggiornata voce per: ${macro} - ${micro} [#${shortId}]`);
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

    getAtlasEntryFull: (campaignId: number, macro: string, micro: string): AtlasEntryFull | null => {
        return db.prepare(`
            SELECT *
            FROM location_atlas
            WHERE campaign_id = ?
              AND lower(macro_location) = lower(?)
              AND lower(micro_location) = lower(?)
        `).get(campaignId, macro, micro) as AtlasEntryFull || null;
    },

    getAtlasEntryByShortId: (campaignId: number, shortId: string): AtlasEntryFull | null => {
        const cleanId = shortId.startsWith('#') ? shortId.substring(1) : shortId;
        return db.prepare(`
            SELECT * FROM location_atlas 
            WHERE campaign_id = ? AND short_id = ?
        `).get(campaignId, cleanId) as AtlasEntryFull || null;
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
            SELECT h.id, h.macro_location, h.micro_location, h.timestamp, h.session_date, h.session_id, s.session_number
            FROM location_history h
            LEFT JOIN sessions s ON h.session_id = s.session_id
            WHERE h.campaign_id = ?
            ORDER BY h.timestamp DESC
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
    addAtlasEvent: (campaignId: number, macro: string, micro: string, sessionId: string | null, description: string, type: string, isManual: boolean = false, timestamp?: number) => {
        db.prepare(`
            INSERT INTO atlas_history (campaign_id, macro_location, micro_location, session_id, description, event_type, timestamp, is_manual)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(campaignId, macro, micro, sessionId, description, type, timestamp || Date.now(), isManual ? 1 : 0);
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
    },

    clearSessionLocationHistory: (sessionId: string): void => {
        db.prepare('DELETE FROM location_history WHERE session_id = ?').run(sessionId);
    }
};
