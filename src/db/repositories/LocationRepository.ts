import { db } from '../client';
import { getByShortId, listEntities, countEntities, ListOptions } from './shared';
import { AtlasEntryFull } from '../types';
import { campaignRepository } from './CampaignRepository';
import { generateShortId } from '../utils/idGenerator';

export const locationRepository = {
    updateLocation: (campaignId: number, macro: string | null, micro: string | null, sessionId?: string, reason?: string, timestamp?: number, isManual: boolean = false, skipHistory: boolean = false): void => {
        // 1. Update the campaign's current state
        const current = campaignRepository.getCampaignLocationById(campaignId);

        // When it is identical AND from the same session, do nothing (avoids spamming the history)
        // BUT when the session is different (e.g. a new journey recorded in S3 at the arrival point of S2), store it.
        const lastHistory = db.prepare('SELECT session_id FROM location_history WHERE campaign_id = ? ORDER BY timestamp DESC LIMIT 1').get(campaignId) as { session_id: string } | undefined;
        const isSameSession = lastHistory?.session_id === sessionId;

        if (current && current.macro === macro && current.micro === micro && isSameSession) return;

        const stmt = db.prepare(`
            UPDATE campaigns 
            SET current_macro_location = COALESCE(?, current_macro_location), 
                current_micro_location = ? 
            WHERE id = ?
        `);
        // Note: Micro can be reset, Macro we tend to keep when unspecified
        stmt.run(macro, micro, campaignId);

        // 2. Append to the history (only when not explicitly skipped)
        // skipHistory = true is used by listen.ts to record only the session's
        // starting position, which will then be inserted correctly by the AI
        // via travel_sequence at the end of the session.
        if (skipHistory) {
            console.log(`[DB] 🗺️ Luogo aggiornato (no history): [${macro}] - (${micro})`);
            return;
        }

        let legacyLocation = "Sconosciuto";
        if (macro && micro) legacyLocation = `${macro} | ${micro}`;
        else if (macro) legacyLocation = macro;
        else if (micro) legacyLocation = micro;

        const effectiveTimestamp = timestamp || Date.now();
        const sessionDateString = new Date(effectiveTimestamp).toISOString().split('T')[0];

        const historyStmt = db.prepare(`
            INSERT INTO location_history (campaign_id, location, macro_location, micro_location, session_id, reason, timestamp, session_date, is_manual, short_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const shortId = generateShortId('location_history');
        historyStmt.run(campaignId, legacyLocation, macro, micro, sessionId || null, reason || null, effectiveTimestamp, sessionDateString, isManual ? 1 : 0, shortId);

        console.log(`[DB] 🗺️ Luogo aggiornato: [${macro}] - (${micro})`);
    },

    getLocationHistory: (guildId: string) => {
        return db.prepare(`
            SELECT h.short_id, h.macro_location, h.micro_location, h.timestamp, h.session_date, s.session_number 
            FROM location_history h
            JOIN campaigns c ON h.campaign_id = c.id
            LEFT JOIN sessions s ON h.session_id = s.session_id
            WHERE c.guild_id = ? AND c.is_active = 1
            ORDER BY h.timestamp DESC
            LIMIT 20
        `).all(guildId);
    },

    getAtlasEntry: (campaignId: number, macro: string, micro: string): string | null => {
        // Normalise the strings to avoid "Taverna" vs "taverna" duplicates
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

        // Use existing names to preserve original case in UPSERT
        const upsertMacro = existing ? existing.macro_location : macro;
        const upsertMicro = existing ? existing.micro_location : micro;

        // IMPORTANT: last_updated_session_id tracks who modified it last (for a clean purge)
        db.prepare(`
            INSERT INTO location_atlas (campaign_id, macro_location, micro_location, description, last_updated, first_session_id, last_updated_session_id, rag_sync_needed, is_manual, short_id, manual_description)
            VALUES ($campaignId, $macro, $micro, $desc, CURRENT_TIMESTAMP, $sessionId, $sessionId, 1, $isManual, $shortId, CASE WHEN $isManual = 1 THEN $desc ELSE NULL END)
            ON CONFLICT(campaign_id, macro_location, micro_location)
            DO UPDATE SET
                description = $desc,
                last_updated = CURRENT_TIMESTAMP,
                last_updated_session_id = $sessionId,
                rag_sync_needed = 1,
                is_manual = $isManual,
                manual_description = CASE WHEN $isManual = 1 THEN $desc ELSE manual_description END
        `).run({ campaignId, macro: upsertMacro, micro: upsertMicro, desc: safeDesc, sessionId: sessionId || null, isManual: isManual ? 1 : 0, shortId });

        console.log(`[Atlas] 📖 Aggiornata voce per: ${upsertMacro} - ${upsertMicro} [#${shortId}]`);
    },

    listAtlasEntries: (campaignId: number, limit: number = 15, offset: number = 0, opts: ListOptions = {}): any[] =>
        listEntities(
            'location_atlas',
            'id, short_id, macro_location, micro_location, description, last_updated',
            campaignId,
            'last_updated DESC',
            { limit, offset, ...opts },
        ),

    countAtlasEntries: (campaignId: number, opts: ListOptions = {}): number =>
        countEntities('location_atlas', campaignId, opts),

    listAllAtlasEntries: (campaignId: number): any[] => {
        return db.prepare(`
            SELECT id, short_id, macro_location, micro_location, description, last_updated
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
            // Clean up atlas_history for deleted entry
            db.prepare(`
                DELETE FROM atlas_history
                WHERE campaign_id = ?
                  AND lower(macro_location) = lower(?)
                  AND lower(micro_location) = lower(?)
            `).run(campaignId, macro, micro);

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

    getAtlasEntryByShortId: (campaignId: number, shortId: string): AtlasEntryFull | null =>
        getByShortId<AtlasEntryFull>('location_atlas', campaignId, shortId),

    getAtlasEntryById: (campaignId: number, id: number): AtlasEntryFull | null => {
        return db.prepare(`
            SELECT * FROM location_atlas 
            WHERE campaign_id = ? AND id = ?
        `).get(campaignId, id) as AtlasEntryFull || null;
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

            // Update atlas_history references
            db.prepare(`
                UPDATE atlas_history
                SET macro_location = ?, micro_location = ?
                WHERE campaign_id = ?
                  AND lower(macro_location) = lower(?)
                  AND lower(micro_location) = lower(?)
            `).run(newMacro, newMicro, campaignId, oldMacro, oldMicro);

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

            db.prepare(`
                UPDATE atlas_history
                SET macro_location = ?, micro_location = ?
                WHERE campaign_id = ?
                  AND lower(macro_location) = lower(?)
                  AND lower(micro_location) = lower(?)
            `).run(newMacro, newMicro, campaignId, oldMacro, oldMicro);

            // Update knowledge_fragments location references
            db.prepare(`
                UPDATE knowledge_fragments
                SET macro_location = ?, micro_location = ?
                WHERE campaign_id = ?
                  AND lower(COALESCE(macro_location, '')) = lower(?)
                  AND lower(COALESCE(micro_location, '')) = lower(?)
            `).run(newMacro, newMicro, campaignId, oldMacro, oldMicro);

            db.prepare(`DELETE FROM location_atlas WHERE id = ?`).run(source.id);
        })();

        console.log(`[Atlas] 🔀 Merged: ${oldMacro} - ${oldMicro} -> ${newMacro} - ${newMicro}`);
        return true;
    },

    getLocationHistoryWithIds: (campaignId: number, limit: number = 20): any[] => {
        return db.prepare(`
            SELECT h.id, h.short_id, h.macro_location, h.micro_location, h.timestamp, h.session_date, h.session_id, s.session_number
            FROM location_history h
            LEFT JOIN sessions s ON h.session_id = s.session_id
            WHERE h.campaign_id = ?
            ORDER BY h.timestamp DESC
            LIMIT ?
        `).all(campaignId, limit);
    },

    /**
     * The visits to one place, newest first.
     *
     * location_history (who went where, when) and atlas_history (what happened
     * there, narratively) are separate concepts and must not be merged.
     */
    getLocationTravelLog: (campaignId: number, macro: string, micro: string): any[] => {
        return db.prepare(`
            SELECT h.id, h.short_id, h.macro_location, h.micro_location, h.timestamp, h.session_date,
                   h.session_id, h.reason, s.session_number
            FROM location_history h
            LEFT JOIN sessions s ON h.session_id = s.session_id
            WHERE h.campaign_id = ?
              AND lower(h.macro_location) = lower(?)
              AND lower(h.micro_location) = lower(?)
            ORDER BY h.timestamp DESC
        `).all(campaignId, macro, micro);
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
            WHERE campaign_id = ? AND lower(macro_location) = lower(?) AND lower(micro_location) = lower(?)
        `).run(campaignId, macro, micro);
    },

    markAtlasDirty: (campaignId: number, macro: string, micro: string): void => {
        db.prepare(`
            UPDATE location_atlas
            SET rag_sync_needed = 1
            WHERE campaign_id = ? AND lower(macro_location) = lower(?) AND lower(micro_location) = lower(?)
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

    // `id`, `timestamp` and `is_manual` were missing from this SELECT while every
    // other *_history getter returns them: the web had no stable key for a
    // location event and rendered every date as "—". Additive — the RAG sync and
    // agent tools that call this only read description/event_type/session_id.
    getAtlasHistory: (campaignId: number, macro: string, micro: string): { id: number, description: string, event_type: string, session_id: string, timestamp: number, is_manual: number }[] => {
        return db.prepare(`
            SELECT id, description, event_type, session_id, timestamp, is_manual
            FROM atlas_history
            WHERE campaign_id = ?
            AND lower(macro_location) = lower(?)
            AND lower(micro_location) = lower(?)
            ORDER BY timestamp ASC
        `).all(campaignId, macro, micro) as { id: number, description: string, event_type: string, session_id: string, timestamp: number, is_manual: number }[];
    },

    countAtlasHistory: (campaignId: number, macro: string, micro: string): number => {
        const row = db.prepare(`
            SELECT COUNT(*) as count FROM atlas_history
            WHERE campaign_id = ?
            AND lower(macro_location) = lower(?)
            AND lower(micro_location) = lower(?)
        `).get(campaignId, macro, micro) as { count: number };
        return row.count;
    },

    clearSessionLocationHistory: (sessionId: string): void => {
        db.prepare('DELETE FROM location_history WHERE session_id = ?').run(sessionId);
    }
};
