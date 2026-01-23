import { db } from '../client';
import { NpcEntry } from '../types';

export const npcRepository = {
    updateNpcEntry: (campaignId: number, name: string, description: string, role?: string, status?: string, sessionId?: string) => {
        // Sanitize
        const safeDesc = (typeof description === 'object') ? JSON.stringify(description) : String(description);

        // Upsert
        db.prepare(`
            INSERT INTO npc_dossier (campaign_id, name, description, role, status, last_updated, first_session_id, rag_sync_needed)
            VALUES ($campaignId, $name, $description, $role, $status, CURRENT_TIMESTAMP, $sessionId, 1)
            ON CONFLICT(campaign_id, name) 
            DO UPDATE SET 
                description = $description, 
                role = COALESCE($role, role), 
                status = COALESCE($status, status),
                last_updated = CURRENT_TIMESTAMP,
                rag_sync_needed = 1
        `).run({
            campaignId,
            name,
            description: safeDesc,
            role: role || null,
            status: status || 'ALIVE',
            sessionId: sessionId || null
        });

        console.log(`[NPC] 👤 Aggiornato dossier per: ${name}`);
    },

    updateNpcFields: (campaignId: number, name: string, fields: Partial<NpcEntry>): boolean => {
        // Build dynamic update query
        const sets: string[] = [];
        const params: any = { campaignId, name };

        if (fields.description !== undefined) { sets.push('description = $description'); params.$description = fields.description; }
        if (fields.role !== undefined) { sets.push('role = $role'); params.$role = fields.role; }
        if (fields.status !== undefined) { sets.push('status = $status'); params.$status = fields.status; }
        if (fields.aliases !== undefined) { sets.push('aliases = $aliases'); params.$aliases = fields.aliases; }

        if (sets.length === 0) return false;

        sets.push('last_updated = CURRENT_TIMESTAMP');
        sets.push('rag_sync_needed = 1');

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

    listNpcs: (campaignId: number, limit: number = 10): NpcEntry[] => {
        return db.prepare('SELECT * FROM npc_dossier WHERE campaign_id = ? ORDER BY last_updated DESC LIMIT ?').all(campaignId, limit) as NpcEntry[];
    },

    addNpcEvent: (campaignId: number, npcName: string, sessionId: string, description: string, type: string) => {
        db.prepare(`
            INSERT INTO npc_history (campaign_id, npc_name, session_id, description, event_type, timestamp)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(campaignId, npcName, sessionId, description, type, Date.now());
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
            SELECT name, role, status, description 
            FROM npc_dossier
            WHERE campaign_id = ? 
            AND (lower(name) LIKE lower(?) OR lower(aliases) LIKE lower(?))
            LIMIT 5
        `).all(campaignId, `%${query}%`, `%${query}%`);
    }
};
