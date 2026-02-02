import { db } from '../client';
import { NpcEntry } from '../types';
import { generateShortId } from '../utils/idGenerator';
import { getMoralAlignment, getEthicalAlignment } from '../../utils/alignmentUtils';

export const npcRepository = {
    updateNpcEntry: (campaignId: number, name: string, description: string, role?: string, status?: string, sessionId?: string, isManual: boolean = false, moral?: string, ethical?: string) => {
        // Sanitize
        const safeDesc = (typeof description === 'object') ? JSON.stringify(description) : String(description);

        // Check if exists to determine if we need a new short_id
        const existing = npcRepository.getNpcEntry(campaignId, name);
        const shortId = existing?.short_id || generateShortId('npc_dossier');

        // Upsert - IMPORTANTE: last_updated_session_id traccia chi ha modificato per ultimo (per purge pulito)
        db.prepare(`
            INSERT INTO npc_dossier (campaign_id, name, description, role, status, last_updated, first_session_id, last_updated_session_id, rag_sync_needed, is_manual, short_id, alignment_moral, alignment_ethical, manual_description)
            VALUES ($campaignId, $name, $description, $role, COALESCE($status, 'ALIVE'), CURRENT_TIMESTAMP, $sessionId, $sessionId, 1, $isManual, $shortId, $moral, $ethical, CASE WHEN $isManual = 1 THEN $description ELSE NULL END)
            ON CONFLICT(campaign_id, name)
            DO UPDATE SET
                description = $description,
                role = COALESCE($role, role),
                status = COALESCE($status, status),
                last_updated = CURRENT_TIMESTAMP,
                last_updated_session_id = $sessionId,
                rag_sync_needed = 1,
                is_manual = $isManual,
                manual_description = CASE WHEN $isManual = 1 THEN $description ELSE manual_description END,
                alignment_moral = COALESCE($moral, alignment_moral),
                alignment_ethical = COALESCE($ethical, alignment_ethical)
        `).run({
            campaignId,
            name,
            description: safeDesc,
            role: role || null,
            status: status || null, // Pass null to let SQL handle COALESCE
            sessionId: sessionId || null,
            isManual: isManual ? 1 : 0,
            shortId,
            moral: moral || null,
            ethical: ethical || null
        });

        console.log(`[NPC] 👤 Aggiornato dossier per: ${name} [#${shortId}]`);
    },

    updateNpcFields: (campaignId: number, name: string, fields: Partial<NpcEntry>, isManual: boolean = true): boolean => {
        // Build dynamic update query
        const sets: string[] = [];
        const params: any = { campaignId, name };

        if (fields.description !== undefined) {
            sets.push('description = $description');
            params.description = fields.description;
            if (isManual) {
                sets.push('manual_description = $description');
            }
        }
        if (fields.role !== undefined) { sets.push('role = $role'); params.role = fields.role; }
        if (fields.status !== undefined) { sets.push('status = $status'); params.status = fields.status; }
        if (fields.aliases !== undefined) { sets.push('aliases = $aliases'); params.aliases = fields.aliases; }
        if (fields.alignment_moral !== undefined) { sets.push('alignment_moral = $alignment_moral'); params.alignment_moral = fields.alignment_moral; }
        if (fields.alignment_ethical !== undefined) { sets.push('alignment_ethical = $alignment_ethical'); params.alignment_ethical = fields.alignment_ethical; }
        if (fields.last_seen_location !== undefined) { sets.push('last_seen_location = $last_seen_location'); params.last_seen_location = fields.last_seen_location; }

        if (sets.length === 0) return false;

        sets.push('last_updated = CURRENT_TIMESTAMP');
        if (isManual) {
            sets.push('is_manual = 1');
        }

        const res = db.prepare(`
            UPDATE npc_dossier 
            SET ${sets.join(', ')} 
            WHERE campaign_id = $campaignId AND name = $name
        `).run(params);

        return res.changes > 0;
    },

    getNpcEntry: (campaignId: number, name: string): NpcEntry | undefined => {
        return db.prepare('SELECT * FROM npc_dossier WHERE campaign_id = ? AND lower(name) = lower(?)').get(campaignId, name) as NpcEntry | undefined;
    },

    listNpcs: (campaignId: number, limit: number = 10, offset: number = 0): NpcEntry[] => {
        return db.prepare('SELECT * FROM npc_dossier WHERE campaign_id = ? ORDER BY last_updated DESC LIMIT ? OFFSET ?').all(campaignId, limit, offset) as NpcEntry[];
    },

    countNpcs: (campaignId: number): number => {
        const result = db.prepare('SELECT COUNT(*) as count FROM npc_dossier WHERE campaign_id = ?').get(campaignId) as { count: number };
        return result.count;
    },

    addNpcEvent: (campaignId: number, npcName: string, sessionId: string, description: string, type: string, isManual: boolean = false, timestamp?: number, moral_weight: number = 0, ethical_weight: number = 0, factionId?: number) => {
        const { factionRepository } = require('../index'); // Lazy load

        db.transaction(() => {
            // 1. Insert Event
            db.prepare(`
                INSERT INTO npc_history (campaign_id, npc_name, session_id, description, event_type, timestamp, is_manual, moral_weight, ethical_weight, faction_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(campaignId, npcName, sessionId, description, type, timestamp || Date.now(), isManual ? 1 : 0, moral_weight, ethical_weight, factionId || null);

            // 2. Update Scores if needed
            if (moral_weight !== 0 || ethical_weight !== 0) {
                // Update numerical scores
                db.prepare(`
                    UPDATE npc_dossier 
                    SET moral_score = CAST(COALESCE(moral_score, 0) AS INTEGER) + ?, 
                        ethical_score = CAST(COALESCE(ethical_score, 0) AS INTEGER) + ?,
                        last_updated = CURRENT_TIMESTAMP,
                        rag_sync_needed = 1
                    WHERE campaign_id = ? AND lower(name) = lower(?)
                `).run(moral_weight, ethical_weight, campaignId, npcName);

                // 3. Recalculate Alignment Labels
                const npc = npcRepository.getNpcEntry(campaignId, npcName);
                if (npc) {
                    const mLabel = getMoralAlignment(npc.moral_score || 0);
                    const eLabel = getEthicalAlignment(npc.ethical_score || 0);

                    db.prepare(`
                       UPDATE npc_dossier
                       SET alignment_moral = ?, alignment_ethical = ?
                       WHERE id = ?
                   `).run(mLabel, eLabel, npc.id);

                    console.log(`[NPC] ⚖️ Alignment Updated for ${npcName}: ${eLabel} ${mLabel} (M:${npc.moral_score}, E:${npc.ethical_score})`);

                    // 4. Handle Faction Link (Member vs Interaction)
                    if (factionId) {
                        // Check if NPC is a member of this specific faction
                        const affiliation = db.prepare(`
                             SELECT 1 FROM faction_affiliations 
                             WHERE faction_id = ? AND entity_type = 'npc' AND entity_id = ? AND is_active = 1
                        `).get(factionId, npc.id);

                        if (affiliation) {
                            // It's their faction: Action reflects on the Faction's alignment
                            factionRepository.updateFactionAlignmentScore(campaignId, factionId, moral_weight, ethical_weight);
                        } else {
                            // It's a target faction: Log interaction (Reputation context)
                            factionRepository.addFactionEvent(
                                campaignId,
                                factionRepository.getFactionById(factionId)?.name || 'Unknown Faction',
                                sessionId,
                                `[INTERAZIONE NPC] ${npcName}: ${description}`,
                                'GENERIC',
                                false,
                                0,
                                0,
                                0
                            );
                        }
                    }
                }
            }
        })();
    },



    getNpcHistory: (campaignId: number, npcName: string): any[] => {
        return db.prepare(`
            SELECT * FROM npc_history 
            WHERE campaign_id = ? AND npc_name = ?
            ORDER BY timestamp ASC
        `).all(campaignId, npcName);
    },

    getAllNpcs: (campaignId: number): NpcEntry[] => {
        return db.prepare('SELECT * FROM npc_dossier WHERE campaign_id = ?').all(campaignId) as NpcEntry[];
    },

    getDirtyNpcDossiers: (campaignId: number): NpcEntry[] => {
        return db.prepare('SELECT * FROM npc_dossier WHERE campaign_id = ? AND rag_sync_needed = 1').all(campaignId) as NpcEntry[];
    },

    markNpcDirty: (campaignId: number, name: string): void => {
        db.prepare('UPDATE npc_dossier SET rag_sync_needed = 1 WHERE campaign_id = ? AND name = ?').run(campaignId, name);
    },

    clearNpcDirtyFlag: (campaignId: number, name: string): void => {
        db.prepare('UPDATE npc_dossier SET rag_sync_needed = 0 WHERE campaign_id = ? AND name = ?').run(campaignId, name);
    },

    updateNpcLastSeenLocation: (campaignId: number, name: string, location: string): void => {
        const res = db.prepare(`
            UPDATE npc_dossier 
            SET last_seen_location = ?, last_updated = CURRENT_TIMESTAMP
            WHERE campaign_id = ? AND lower(name) = lower(?)
        `).run(location, campaignId, name);
        if (res.changes > 0) {
            console.log(`[NPC] 📍 Aggiornata posizione per ${name}: ${location}`);
        }
    },

    getNpcByAlias: (campaignId: number, alias: string): NpcEntry | undefined => {
        return db.prepare(`
            SELECT * FROM npc_dossier 
            WHERE campaign_id = ? 
            AND (lower(name) = lower(?) OR ',' || lower(aliases) || ',' LIKE ?)
        `).get(campaignId, alias, `%,${alias.toLowerCase()},%`) as NpcEntry | undefined;
    },

    addNpcAlias: (campaignId: number, name: string, alias: string): boolean => {
        const npc = npcRepository.getNpcEntry(campaignId, name);
        if (!npc) return false;

        const aliases = npc.aliases ? npc.aliases.split(',').map(s => s.trim()) : [];
        if (!aliases.includes(alias)) {
            aliases.push(alias);
            db.prepare('UPDATE npc_dossier SET aliases = ?, rag_sync_needed = 1 WHERE id = ?').run(aliases.join(','), npc.id);
            return true;
        }
        return false;
    },

    removeNpcAlias: (campaignId: number, name: string, alias: string): boolean => {
        const npc = npcRepository.getNpcEntry(campaignId, name);
        if (!npc || !npc.aliases) return false;

        const aliases = npc.aliases.split(',').map(s => s.trim());
        const newAliases = aliases.filter(a => a.toLowerCase() !== alias.toLowerCase());

        if (aliases.length !== newAliases.length) {
            db.prepare('UPDATE npc_dossier SET aliases = ?, rag_sync_needed = 1 WHERE id = ?').run(newAliases.join(','), npc.id);
            return true;
        }
        return false;
    },

    getNpcIdByName: (campaignId: number, name: string): number | null => {
        const row = db.prepare('SELECT id FROM npc_dossier WHERE campaign_id = ? AND lower(name) = lower(?)').get(campaignId, name) as { id: number } | undefined;
        return row ? row.id : null;
    },

    getNpcNameById: (campaignId: number, npcId: number): string | null => {
        const row = db.prepare('SELECT name FROM npc_dossier WHERE campaign_id = ? AND id = ?').get(campaignId, npcId) as { name: string } | undefined;
        return row ? row.name : null;
    },

    updateNpcAliases: (campaignId: number, name: string, aliases: string[]): boolean => {
        const res = db.prepare(`
            UPDATE npc_dossier 
            SET aliases = ?, last_updated = CURRENT_TIMESTAMP, rag_sync_needed = 1 
            WHERE campaign_id = ? AND lower(name) = lower(?)
        `).run(aliases.join(','), campaignId, name);
        return res.changes > 0;
    },

    renameNpcEntry: (campaignId: number, oldName: string, newName: string): boolean => {
        const existing = npcRepository.getNpcEntry(campaignId, oldName);
        if (!existing) return false;

        const conflict = npcRepository.getNpcEntry(campaignId, newName);

        db.transaction(() => {
            if (conflict) {
                // MERGE: Unisce le descrizioni
                const mergedDesc = [existing.description, conflict.description]
                    .filter(d => d && d.trim().length > 0).join(' | ');

                // Aggiorna destination
                db.prepare(`
                    UPDATE npc_dossier 
                    SET description = ?, last_updated = CURRENT_TIMESTAMP, rag_sync_needed = 1
                    WHERE id = ?
                `).run(mergedDesc, conflict.id);

                // Aggiorna history to point to new name
                db.prepare(`
                    UPDATE npc_history 
                    SET npc_name = ? 
                    WHERE campaign_id = ? AND lower(npc_name) = lower(?)
                `).run(newName, campaignId, oldName);

                // Delete old
                db.prepare('DELETE FROM npc_dossier WHERE id = ?').run(existing.id);
                console.log(`[DB] NPC Merged: "${oldName}" -> "${newName}"`);
            } else {
                // RENAME SEMPLICE
                db.prepare('UPDATE npc_dossier SET name = ?, rag_sync_needed = 1 WHERE id = ?').run(newName, existing.id);
                db.prepare('UPDATE npc_history SET npc_name = ? WHERE campaign_id = ? AND lower(npc_name) = lower(?)').run(newName, campaignId, oldName);
                console.log(`[DB] NPC Renamed: "${oldName}" -> "${newName}"`);
            }
        })();
        return true;
    },

    deleteNpcEntry: (campaignId: number, name: string): boolean => {
        const res = db.prepare('DELETE FROM npc_dossier WHERE campaign_id = ? AND name = ?').run(campaignId, name);
        return res.changes > 0;
    },

    deleteNpcHistory: (campaignId: number, name: string): boolean => {
        const res = db.prepare('DELETE FROM npc_history WHERE campaign_id = ? AND npc_name = ?').run(campaignId, name);
        return res.changes > 0;
    },

    getSessionEncounteredNPCs: (sessionId: string): NpcEntry[] => {
        // 1. Gather names
        const npcSet = new Set<string>();

        // From recordings
        const recs = db.prepare(`
            SELECT present_npcs FROM recordings 
            WHERE session_id = ? AND present_npcs IS NOT NULL
        `).all(sessionId) as { present_npcs: string }[];

        for (const r of recs) {
            try {
                const names = JSON.parse(r.present_npcs);
                if (Array.isArray(names)) {
                    names.forEach((n: string) => npcSet.add(n));
                }
            } catch (e) { }
        }

        // From history
        const events = db.prepare(`
            SELECT npc_name FROM npc_history WHERE session_id = ?
        `).all(sessionId) as { npc_name: string }[];
        events.forEach(e => npcSet.add(e.npc_name));

        // From knowledge
        const fragments = db.prepare(`
            SELECT associated_npcs FROM knowledge_fragments 
            WHERE session_id = ? AND associated_npcs IS NOT NULL
        `).all(sessionId) as { associated_npcs: string }[];

        for (const f of fragments) {
            try {
                const names = JSON.parse(f.associated_npcs);
                if (Array.isArray(names)) {
                    names.forEach((n: string) => npcSet.add(n));
                }
            } catch (e) { }
        }

        if (npcSet.size === 0) return [];

        // 2. Fetch details from DB
        const namesArray = Array.from(npcSet);
        const placeholders = namesArray.map(() => '?').join(',');

        const session = db.prepare('SELECT campaign_id FROM sessions WHERE session_id = ?').get(sessionId) as { campaign_id: number } | undefined;

        if (!session) {
            return namesArray.map(name => ({
                id: 0, campaign_id: 0, name, role: null, description: null, status: 'UNKNOWN', last_seen_location: null, last_updated: ''
            }));
        }

        return db.prepare(`
            SELECT * FROM npc_dossier 
            WHERE campaign_id = ? AND name IN (${placeholders})
        `).all(session.campaign_id, ...namesArray) as NpcEntry[];
    },

    findNpcDossierByName: (campaignId: number, query: string): any[] => {
        return db.prepare(`
            SELECT short_id, name, role, status, description 
            FROM npc_dossier
            WHERE campaign_id = ? 
            AND (lower(name) LIKE lower(?) OR lower(aliases) LIKE lower(?))
            LIMIT 5
        `).all(campaignId, `%${query}%`, `%${query}%`);
    },

    getNpcByShortId: (campaignId: number, shortId: string): NpcEntry | null => {
        const cleanId = shortId.startsWith('#') ? shortId.substring(1) : shortId;
        return db.prepare(`SELECT * FROM npc_dossier WHERE campaign_id = ? AND short_id = ?`).get(campaignId, cleanId) as NpcEntry | null;
    },

    restoreManualNpcDescription: (campaignId: number, name: string): boolean => {
        const npc = npcRepository.getNpcEntry(campaignId, name);
        if (!npc || !(npc as any).manual_description) return false;

        const manualDesc = (npc as any).manual_description;
        db.prepare(`
            UPDATE npc_dossier 
            SET description = ?, is_manual = 1, last_updated = CURRENT_TIMESTAMP, rag_sync_needed = 1
            WHERE campaign_id = ? AND name = ?
        `).run(manualDesc, campaignId, name);

        console.log(`[NPC] ↩️ Ripristinata descrizione manuale per ${name}`);
        return true;
    },

    clearManualNpcDescription: (campaignId: number, name: string): boolean => {
        const res = db.prepare(`
            UPDATE npc_dossier 
            SET manual_description = NULL, last_updated = CURRENT_TIMESTAMP 
            WHERE campaign_id = ? AND name = ?
        `).run(campaignId, name);

        if (res.changes > 0) {
            console.log(`[NPC] 🔓 Rimossa descrizione manuale (Unlock) per ${name}`);
            return true;
        }
        return false;
    }
};
