import { db } from '../client';
import {
    FactionEntry,
    FactionReputation,
    FactionAffiliation,
    FactionHistoryEntry,
    ReputationLevel,
    FactionType,
    FactionStatus,
    AffiliationRole,
    AffiliationEntityType,
    REPUTATION_SPECTRUM
} from '../types';
import { generateShortId } from '../utils/idGenerator';

export const factionRepository = {
    // =============================================
    // FACTION CRUD
    // =============================================

    createFaction: (
        campaignId: number,
        name: string,
        options?: {
            description?: string;
            type?: FactionType;
            isParty?: boolean;
            sessionId?: string;
            isManual?: boolean;
        }
    ): FactionEntry | null => {
        const shortId = generateShortId('factions');
        const type = options?.type || 'GENERIC';
        const isParty = options?.isParty ? 1 : 0;
        const isManual = options?.isManual ? 1 : 0;

        try {
            db.prepare(`
                INSERT INTO factions (campaign_id, name, description, type, is_party, first_session_id, is_manual, short_id)
                VALUES ($campaignId, $name, $description, $type, $isParty, $sessionId, $isManual, $shortId)
            `).run({
                campaignId,
                name,
                description: options?.description || null,
                type,
                isParty,
                sessionId: options?.sessionId || null,
                isManual,
                shortId
            });

            console.log(`[Faction] ⚔️ Creata fazione: ${name} [#${shortId}]${isParty ? ' (PARTY)' : ''}`);
            return factionRepository.getFaction(campaignId, name);
        } catch (e: any) {
            if (e.message?.includes('UNIQUE constraint')) {
                console.log(`[Faction] ⚠️ Fazione "${name}" già esistente.`);
                return factionRepository.getFaction(campaignId, name);
            }
            throw e;
        }
    },

    updateFaction: (
        campaignId: number,
        name: string,
        fields: Partial<Omit<FactionEntry, 'id' | 'campaign_id' | 'short_id'>>,
        isManual: boolean = true
    ): boolean => {
        const sets: string[] = [];
        const params: any = { campaignId, name };

        if (fields.description !== undefined) { sets.push('description = $description'); params.description = fields.description; }
        if (fields.type !== undefined) { sets.push('type = $type'); params.type = fields.type; }
        if (fields.status !== undefined) { sets.push('status = $status'); params.status = fields.status; }
        if (fields.leader_npc_id !== undefined) { sets.push('leader_npc_id = $leaderNpcId'); params.leaderNpcId = fields.leader_npc_id; }
        if (fields.headquarters_location_id !== undefined) { sets.push('headquarters_location_id = $hqLocId'); params.hqLocId = fields.headquarters_location_id; }
        if (fields.alignment_moral !== undefined) { sets.push('alignment_moral = $alignmentMoral'); params.alignmentMoral = fields.alignment_moral; }
        if (fields.alignment_ethical !== undefined) { sets.push('alignment_ethical = $alignmentEthical'); params.alignmentEthical = fields.alignment_ethical; }

        if (sets.length === 0) return false;

        sets.push('last_updated = CURRENT_TIMESTAMP');
        sets.push('rag_sync_needed = 1');
        if (isManual) sets.push('is_manual = 1');

        const res = db.prepare(`
            UPDATE factions 
            SET ${sets.join(', ')} 
            WHERE campaign_id = $campaignId AND lower(name) = lower($name)
        `).run(params);

        return res.changes > 0;
    },

    getFaction: (campaignId: number, name: string): FactionEntry | null => {
        return db.prepare(`
            SELECT * FROM factions 
            WHERE campaign_id = ? AND lower(name) = lower(?)
        `).get(campaignId, name) as FactionEntry | null;
    },

    getFactionById: (id: number): FactionEntry | null => {
        return db.prepare('SELECT * FROM factions WHERE id = ?').get(id) as FactionEntry | null;
    },

    getFactionByShortId: (campaignId: number, shortId: string): FactionEntry | null => {
        const cleanId = shortId.startsWith('#') ? shortId.substring(1) : shortId;
        return db.prepare(`
            SELECT * FROM factions WHERE campaign_id = ? AND short_id = ?
        `).get(campaignId, cleanId) as FactionEntry | null;
    },

    listFactions: (campaignId: number, includeParty: boolean = true): FactionEntry[] => {
        if (includeParty) {
            return db.prepare(`
                SELECT * FROM factions 
                WHERE campaign_id = ? 
                ORDER BY is_party DESC, last_updated DESC
            `).all(campaignId) as FactionEntry[];
        }
        return db.prepare(`
            SELECT * FROM factions 
            WHERE campaign_id = ? AND is_party = 0
            ORDER BY last_updated DESC
        `).all(campaignId) as FactionEntry[];
    },

    deleteFaction: (campaignId: number, name: string): boolean => {
        // Prevent deletion of party faction
        const faction = factionRepository.getFaction(campaignId, name);
        if (faction?.is_party) {
            console.warn(`[Faction] ⚠️ Non è possibile eliminare la fazione Party.`);
            return false;
        }
        const res = db.prepare('DELETE FROM factions WHERE campaign_id = ? AND lower(name) = lower(?)').run(campaignId, name);
        return res.changes > 0;
    },

    renameFaction: (campaignId: number, oldName: string, newName: string): boolean => {
        // Same name = no-op, return success
        if (oldName.toLowerCase() === newName.toLowerCase()) {
            return true;
        }

        // Check for conflict with a different faction
        const existing = factionRepository.getFaction(campaignId, newName);
        if (existing) {
            console.warn(`[Faction] ⚠️ Fazione "${newName}" già esistente.`);
            return false;
        }

        const res = db.prepare(`
            UPDATE factions 
            SET name = ?, last_updated = CURRENT_TIMESTAMP, rag_sync_needed = 1
            WHERE campaign_id = ? AND lower(name) = lower(?)
        `).run(newName, campaignId, oldName);

        // Update history references
        if (res.changes > 0) {
            db.prepare(`
                UPDATE faction_history 
                SET faction_name = ? 
                WHERE campaign_id = ? AND lower(faction_name) = lower(?)
            `).run(newName, campaignId, oldName);
        }

        return res.changes > 0;
    },

    // =============================================
    // PARTY FACTION
    // =============================================

    getPartyFaction: (campaignId: number): FactionEntry | null => {
        return db.prepare(`
            SELECT * FROM factions 
            WHERE campaign_id = ? AND is_party = 1
        `).get(campaignId) as FactionEntry | null;
    },

    createPartyFaction: (campaignId: number, name: string = 'Heros Party'): FactionEntry | null => {
        // Check if party faction already exists
        const existing = factionRepository.getPartyFaction(campaignId);
        if (existing) {
            console.log(`[Faction] ⚠️ Party faction già esistente: ${existing.name}`);
            return existing;
        }

        const party = factionRepository.createFaction(campaignId, name, {
            type: 'PARTY',
            isParty: true,
            description: 'Il gruppo di avventurieri protagonista della campagna.'
        });

        // Auto-affiliate all existing PCs (excluding DM)
        if (party) {
            const characters = db.prepare(`
                SELECT rowid, user_id, character_name, class 
                FROM characters 
                WHERE campaign_id = ? AND lower(class) != 'dungeon master'
            `).all(campaignId) as Array<{ rowid: number; user_id: string; character_name: string; class: string }>;

            for (const char of characters) {
                factionRepository.addAffiliation(party.id, 'pc', char.rowid, { role: 'MEMBER' });
                console.log(`[Faction] 🤝 Auto-affiliato PC: ${char.character_name} -> ${name}`);
            }
        }

        return party;
    },

    renamePartyFaction: (campaignId: number, newName: string): boolean => {
        const party = factionRepository.getPartyFaction(campaignId);
        if (!party) return false;

        return factionRepository.renameFaction(campaignId, party.name, newName);
    },

    /**
     * Ensures all PCs (excluding DM) are affiliated to the party faction.
     * Called on each command to keep party membership in sync.
     */
    ensurePartyMembership: (campaignId: number, partyId: number): void => {
        // Get all PCs not yet in the party (excluding DM)
        const unaffiliatedPCs = db.prepare(`
            SELECT c.rowid, c.character_name 
            FROM characters c
            LEFT JOIN faction_affiliations fa 
                ON fa.entity_type = 'pc' AND fa.entity_id = c.rowid AND fa.faction_id = ?
            WHERE c.campaign_id = ? 
              AND lower(c.class) != 'dungeon master'
              AND fa.id IS NULL
        `).all(partyId, campaignId) as Array<{ rowid: number; character_name: string }>;

        for (const pc of unaffiliatedPCs) {
            factionRepository.addAffiliation(partyId, 'pc', pc.rowid, { role: 'MEMBER' });
            console.log(`[Faction] 🤝 Sync PC al party: ${pc.character_name}`);
        }
    },

    // =============================================
    // REPUTATION
    // =============================================

    setFactionReputation: (campaignId: number, factionId: number, reputation: ReputationLevel): void => {
        db.prepare(`
            INSERT INTO faction_reputation (campaign_id, faction_id, reputation)
            VALUES ($campaignId, $factionId, $reputation)
            ON CONFLICT(campaign_id, faction_id)
            DO UPDATE SET reputation = $reputation, last_updated = CURRENT_TIMESTAMP
        `).run({ campaignId, factionId, reputation });

        console.log(`[Faction] 📊 Reputazione impostata: Faction #${factionId} -> ${reputation}`);
    },

    getFactionReputation: (campaignId: number, factionId: number): ReputationLevel => {
        const row = db.prepare(`
            SELECT reputation FROM faction_reputation 
            WHERE campaign_id = ? AND faction_id = ?
        `).get(campaignId, factionId) as { reputation: ReputationLevel } | undefined;

        return row?.reputation || 'NEUTRALE';
    },

    getReputationWithAllFactions: (campaignId: number): Array<FactionEntry & { reputation: ReputationLevel }> => {
        return db.prepare(`
            SELECT f.*, COALESCE(fr.reputation, 'NEUTRALE') as reputation
            FROM factions f
            LEFT JOIN faction_reputation fr ON f.id = fr.faction_id AND fr.campaign_id = f.campaign_id
            WHERE f.campaign_id = ? AND f.is_party = 0
            ORDER BY f.name
        `).all(campaignId) as Array<FactionEntry & { reputation: ReputationLevel }>;
    },

    adjustReputation: (campaignId: number, factionId: number, direction: 'UP' | 'DOWN'): ReputationLevel => {
        const current = factionRepository.getFactionReputation(campaignId, factionId);
        const currentIndex = REPUTATION_SPECTRUM.indexOf(current);

        let newIndex = currentIndex;
        if (direction === 'UP' && currentIndex < REPUTATION_SPECTRUM.length - 1) {
            newIndex = currentIndex + 1;
        } else if (direction === 'DOWN' && currentIndex > 0) {
            newIndex = currentIndex - 1;
        }

        const newReputation = REPUTATION_SPECTRUM[newIndex];
        factionRepository.setFactionReputation(campaignId, factionId, newReputation);

        return newReputation;
    },

    // =============================================
    // AFFILIATIONS
    // =============================================

    addAffiliation: (
        factionId: number,
        entityType: AffiliationEntityType,
        entityId: number,
        options?: {
            role?: AffiliationRole;
            sessionId?: string;
            notes?: string;
        }
    ): boolean => {
        try {
            db.prepare(`
                INSERT INTO faction_affiliations (faction_id, entity_type, entity_id, role, joined_session_id, notes)
                VALUES ($factionId, $entityType, $entityId, $role, $sessionId, $notes)
                ON CONFLICT(faction_id, entity_type, entity_id)
                DO UPDATE SET role = COALESCE($role, role), is_active = 1, notes = COALESCE($notes, notes)
            `).run({
                factionId,
                entityType,
                entityId,
                role: options?.role || 'MEMBER',
                sessionId: options?.sessionId || null,
                notes: options?.notes || null
            });

            console.log(`[Faction] 🔗 Affiliazione aggiunta: ${entityType}:${entityId} -> Faction #${factionId}`);
            return true;
        } catch (e) {
            console.error('[Faction] ❌ Errore aggiunta affiliazione:', e);
            return false;
        }
    },

    removeAffiliation: (factionId: number, entityType: AffiliationEntityType, entityId: number): boolean => {
        // Soft delete: mark as inactive
        const res = db.prepare(`
            UPDATE faction_affiliations 
            SET is_active = 0 
            WHERE faction_id = ? AND entity_type = ? AND entity_id = ?
        `).run(factionId, entityType, entityId);

        return res.changes > 0;
    },

    getEntityFactions: (entityType: AffiliationEntityType, entityId: number, activeOnly: boolean = true): FactionAffiliation[] => {
        const query = activeOnly
            ? `SELECT fa.*, f.name as faction_name 
               FROM faction_affiliations fa 
               JOIN factions f ON fa.faction_id = f.id
               WHERE fa.entity_type = ? AND fa.entity_id = ? AND fa.is_active = 1`
            : `SELECT fa.*, f.name as faction_name 
               FROM faction_affiliations fa 
               JOIN factions f ON fa.faction_id = f.id
               WHERE fa.entity_type = ? AND fa.entity_id = ?`;

        return db.prepare(query).all(entityType, entityId) as FactionAffiliation[];
    },

    getFactionMembers: (factionId: number, entityType?: AffiliationEntityType, activeOnly: boolean = true): any[] => {
        let query = `
            SELECT fa.*, 
                   CASE 
                     WHEN fa.entity_type = 'npc' THEN n.name 
                     WHEN fa.entity_type = 'location' THEN a.macro_location || ' | ' || a.micro_location
                     ELSE 'ID:' || fa.entity_id
                   END as entity_name
            FROM faction_affiliations fa
            LEFT JOIN npc_dossier n ON fa.entity_type = 'npc' AND fa.entity_id = n.id
            LEFT JOIN location_atlas a ON fa.entity_type = 'location' AND fa.entity_id = a.id
            WHERE fa.faction_id = ?
        `;
        const params: any[] = [factionId];

        if (entityType) {
            query += ` AND fa.entity_type = ?`;
            params.push(entityType);
        }

        if (activeOnly) {
            query += ` AND fa.is_active = 1`;
        }

        return db.prepare(query).all(...params) as any[];
    },

    countFactionMembers: (factionId: number): { npcs: number; locations: number; pcs: number } => {
        const counts = db.prepare(`
            SELECT entity_type, COUNT(*) as count 
            FROM faction_affiliations 
            WHERE faction_id = ? AND is_active = 1
            GROUP BY entity_type
        `).all(factionId) as Array<{ entity_type: string; count: number }>;

        const result = { npcs: 0, locations: 0, pcs: 0 };
        for (const row of counts) {
            if (row.entity_type === 'npc') result.npcs = row.count;
            else if (row.entity_type === 'location') result.locations = row.count;
            else if (row.entity_type === 'pc') result.pcs = row.count;
        }
        return result;
    },

    // =============================================
    // HISTORY
    // =============================================

    addFactionEvent: (
        campaignId: number,
        factionName: string,
        sessionId: string | null,
        description: string,
        eventType: FactionHistoryEntry['event_type'],
        isManual: boolean = false
    ): void => {
        db.prepare(`
            INSERT INTO faction_history (campaign_id, faction_name, session_id, event_type, description, timestamp, is_manual)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(campaignId, factionName, sessionId, eventType, description, Date.now(), isManual ? 1 : 0);
    },

    getFactionHistory: (campaignId: number, factionName: string): FactionHistoryEntry[] => {
        return db.prepare(`
            SELECT * FROM faction_history 
            WHERE campaign_id = ? AND lower(faction_name) = lower(?)
            ORDER BY timestamp ASC
        `).all(campaignId, factionName) as FactionHistoryEntry[];
    },

    // =============================================
    // MERGE
    // =============================================
    mergeFactions: (
        campaignId: number,
        sourceName: string,
        targetName: string,
        mergedDescription?: string
    ): boolean => {
        const source = factionRepository.getFaction(campaignId, sourceName);
        const target = factionRepository.getFaction(campaignId, targetName);

        if (!source || !target) return false;
        if (source.id === target.id) return true;

        db.transaction(() => {
            // 1. Unify descriptions if needed
            if (mergedDescription) {
                factionRepository.updateFaction(campaignId, targetName, { description: mergedDescription });
            }

            // 2. Move History (uses faction_name string)
            db.prepare(`
                UPDATE faction_history 
                SET faction_name = ? 
                WHERE campaign_id = ? AND lower(faction_name) = lower(?)
            `).run(target.name, campaignId, source.name);

            // 3. Move Affiliations (uses faction_id)
            // Handle unique constraint manually to avoid losing metadata if possible
            const sourceAffiliations = db.prepare('SELECT * FROM faction_affiliations WHERE faction_id = ?').all(source.id) as FactionAffiliation[];

            for (const aff of sourceAffiliations) {
                const conflict = db.prepare(`
                    SELECT id, role, notes, is_active 
                    FROM faction_affiliations 
                    WHERE faction_id = ? AND entity_type = ? AND entity_id = ?
                `).get(target.id, aff.entity_type, aff.entity_id) as any;

                if (conflict) {
                    // Conflict: Combine notes if different, maybe keep highest role?
                    // For now, just combine notes and keep target role if set
                    const newNotes = (conflict.notes || '') + (aff.notes ? '\n[Fusa] ' + aff.notes : '');
                    db.prepare(`
                        UPDATE faction_affiliations 
                        SET notes = ?, is_active = MAX(is_active, ?)
                        WHERE id = ?
                    `).run(newNotes, aff.is_active, conflict.id);

                    // Delete source affiliation
                    db.prepare('DELETE FROM faction_affiliations WHERE id = ?').run(aff.id);
                } else {
                    // No conflict: just reassign
                    db.prepare('UPDATE faction_affiliations SET faction_id = ? WHERE id = ?').run(target.id, aff.id);
                }
            }

            // 4. Move Artifacts
            db.prepare(`
                UPDATE artifacts 
                SET faction_id = ? 
                WHERE campaign_id = ? AND faction_id = ?
            `).run(target.id, campaignId, source.id);

            // 5. Reassign Reputation? 
            // If source had a specific reputation, and target has NEUTRALE, maybe move it?
            const sourceRep = factionRepository.getFactionReputation(campaignId, source.id);
            const targetRep = factionRepository.getFactionReputation(campaignId, target.id);
            if (targetRep === 'NEUTRALE' && sourceRep !== 'NEUTRALE') {
                factionRepository.setFactionReputation(campaignId, target.id, sourceRep);
            }

            // 6. Delete source faction
            db.prepare('DELETE FROM factions WHERE id = ?').run(source.id);
        })();

        console.log(`[Faction] 🔀 Merged: ${sourceName} -> ${targetName}`);
        return true;
    },

    // =============================================
    // RAG SYNC
    // =============================================

    markFactionDirty: (campaignId: number, name: string): void => {
        db.prepare('UPDATE factions SET rag_sync_needed = 1 WHERE campaign_id = ? AND lower(name) = lower(?)').run(campaignId, name);
    },

    getDirtyFactions: (campaignId: number): FactionEntry[] => {
        return db.prepare('SELECT * FROM factions WHERE campaign_id = ? AND rag_sync_needed = 1').all(campaignId) as FactionEntry[];
    },

    clearFactionDirtyFlag: (campaignId: number, name: string): void => {
        db.prepare('UPDATE factions SET rag_sync_needed = 0 WHERE campaign_id = ? AND lower(name) = lower(?)').run(campaignId, name);
    },

    // =============================================
    // SEARCH
    // =============================================

    findFactionByName: (campaignId: number, query: string): FactionEntry[] => {
        return db.prepare(`
            SELECT * FROM factions
            WHERE campaign_id = ? 
            AND lower(name) LIKE lower(?)
            LIMIT 5
        `).all(campaignId, `%${query}%`) as FactionEntry[];
    }
};
