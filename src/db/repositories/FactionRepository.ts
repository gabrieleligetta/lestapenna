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
import { getMoralAlignment, getEthicalAlignment, ROLE_WEIGHTS, ROLE_PRIORITY, getReputationLabel, getReputationScoreForLabel } from '../../utils/alignmentUtils';

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
                INSERT INTO factions (campaign_id, name, description, type, is_party, first_session_id, is_manual, short_id, manual_description)
                VALUES ($campaignId, $name, $description, $type, $isParty, $sessionId, $isManual, $shortId, $manualDescription)
            `).run({
                campaignId,
                name,
                description: options?.description || null,
                type,
                isParty,
                isPerson: isParty,
                sessionId: options?.sessionId || null,
                isManual,
                shortId,
                manualDescription: isManual ? (options?.description || null) : null
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

        if (fields.description !== undefined) {
            sets.push('description = $description');
            params.description = fields.description;
            if (isManual) {
                sets.push('manual_description = $description');
            }
        }
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
        const score = getReputationScoreForLabel(reputation);
        db.prepare(`
            INSERT INTO faction_reputation (campaign_id, faction_id, reputation, reputation_score)
            VALUES ($campaignId, $factionId, $reputation, $score)
            ON CONFLICT(campaign_id, faction_id)
            DO UPDATE SET reputation = $reputation, reputation_score = $score, last_updated = CURRENT_TIMESTAMP
        `).run({ campaignId, factionId, reputation, score });

        console.log(`[Faction] 📊 Reputazione impostata: Faction #${factionId} -> ${reputation} (score: ${score})`);
    },

    getFactionReputation: (campaignId: number, factionId: number): ReputationLevel => {
        const row = db.prepare(`
            SELECT reputation FROM faction_reputation 
            WHERE campaign_id = ? AND faction_id = ?
        `).get(campaignId, factionId) as { reputation: ReputationLevel } | undefined;

        return row?.reputation || 'NEUTRAL';
    },

    getReputationWithAllFactions: (campaignId: number): Array<FactionEntry & { reputation: ReputationLevel }> => {
        return db.prepare(`
            SELECT f.*, COALESCE(fr.reputation, 'NEUTRAL') as reputation
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
        isManual: boolean = false,
        reputationChange: number = 0,
        moralWeight: number = 0,
        ethicalWeight: number = 0,
        timestamp?: number
    ): void => {
        db.transaction(() => {
            // 1. Insert Event
            db.prepare(`
                INSERT INTO faction_history (campaign_id, faction_name, session_id, event_type, description, timestamp, is_manual, reputation_change_value, moral_weight, ethical_weight)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                campaignId,
                factionName,
                sessionId,
                eventType,
                description,
                timestamp || Date.now(),
                isManual ? 1 : 0,
                reputationChange,
                moralWeight,
                ethicalWeight
            );

            // 2. Update Reputation Score if needed
            if (reputationChange !== 0) {
                const faction = factionRepository.getFaction(campaignId, factionName);
                if (faction && !faction.is_party) {
                    // Accumulate reputation_score and derive label
                    db.prepare(`
                        INSERT INTO faction_reputation (campaign_id, faction_id, reputation, reputation_score)
                        VALUES ($campaignId, $factionId, 'NEUTRAL', MIN(50, MAX(-50, $change)))
                        ON CONFLICT(campaign_id, faction_id)
                        DO UPDATE SET
                            reputation_score = MIN(50, MAX(-50, COALESCE(reputation_score, 0) + $change)),
                            last_updated = CURRENT_TIMESTAMP
                    `).run({ campaignId, factionId: faction.id, change: reputationChange });

                    // Read back accumulated score and derive label
                    const row = db.prepare(`
                        SELECT reputation_score FROM faction_reputation
                        WHERE campaign_id = ? AND faction_id = ?
                    `).get(campaignId, faction.id) as { reputation_score: number } | undefined;

                    const newScore = row?.reputation_score ?? 0;
                    const newLabel = getReputationLabel(newScore);

                    db.prepare(`
                        UPDATE faction_reputation
                        SET reputation = ?
                        WHERE campaign_id = ? AND faction_id = ?
                    `).run(newLabel, campaignId, faction.id);

                    console.log(`[Faction] 📊 Reputation Score: ${factionName} = ${newScore} → ${newLabel}`);
                }
            }

            // 3. Update Alignment Scores if needed
            if (moralWeight !== 0 || ethicalWeight !== 0) {
                // Update faction scores with clamping to [-100, +100]
                db.prepare(`
                    UPDATE factions
                    SET moral_score = MIN(100, MAX(-100, CAST(COALESCE(moral_score, 0) AS INTEGER) + ?)),
                        ethical_score = MIN(100, MAX(-100, CAST(COALESCE(ethical_score, 0) AS INTEGER) + ?)),
                        last_updated = CURRENT_TIMESTAMP,
                        rag_sync_needed = 1
                    WHERE campaign_id = ? AND lower(name) = lower(?)
                `).run(moralWeight, ethicalWeight, campaignId, factionName);

                // 4. Recalculate Alignment Labels & Update Campaign if Party
                const factionForAlign = factionRepository.getFaction(campaignId, factionName);
                if (factionForAlign) {
                    const mLabel = getMoralAlignment(factionForAlign.moral_score || 0);
                    const eLabel = getEthicalAlignment(factionForAlign.ethical_score || 0);

                    db.prepare(`
                       UPDATE factions
                       SET alignment_moral = ?, alignment_ethical = ?
                       WHERE id = ?
                   `).run(mLabel, eLabel, factionForAlign.id);

                    console.log(`[Faction] ⚖️ Alignment Updated for ${factionName}: ${eLabel} ${mLabel} (M:${factionForAlign.moral_score}, E:${factionForAlign.ethical_score})`);

                    // If Party, update campaign scores
                    if (factionForAlign.is_party) {
                        db.prepare(`
                           UPDATE campaigns
                           SET party_moral_score = ?, party_ethical_score = ?
                           WHERE id = ?
                       `).run(factionForAlign.moral_score, factionForAlign.ethical_score, campaignId);
                        console.log(`[Faction] ⚖️ Party Scores Updated for Campaign #${campaignId}`);
                    }
                }
            }
        })();
    },

    /**
     * Incrementally updates faction alignment scores and recalculates labels.
     */
    updateFactionAlignmentScore: (campaignId: number, factionId: number, moralDelta: number, ethicalDelta: number): void => {
        if (moralDelta === 0 && ethicalDelta === 0) return;

        const faction = factionRepository.getFactionById(factionId);
        if (!faction) return;

        db.prepare(`
            UPDATE factions
            SET moral_score = MIN(100, MAX(-100, CAST(COALESCE(moral_score, 0) AS INTEGER) + ?)),
                ethical_score = MIN(100, MAX(-100, CAST(COALESCE(ethical_score, 0) AS INTEGER) + ?)),
                last_updated = CURRENT_TIMESTAMP,
                rag_sync_needed = 1
            WHERE id = ?
        `).run(moralDelta, ethicalDelta, factionId);

        // Recalculate Labels
        const updated = factionRepository.getFactionById(factionId);
        if (updated) {
            const mLabel = getMoralAlignment(updated.moral_score || 0);
            const eLabel = getEthicalAlignment(updated.ethical_score || 0);

            db.prepare(`
               UPDATE factions
               SET alignment_moral = ?, alignment_ethical = ?
               WHERE id = ?
           `).run(mLabel, eLabel, factionId);

            console.log(`[Faction] ⚖️ Alignment Updated for ${faction.name}: ${eLabel} ${mLabel} (M:${updated.moral_score}, E:${updated.ethical_score})`);

            // If Party, update campaign scores
            if (updated.is_party) {
                const { campaignRepository } = require('../index'); // Lazy load to avoid circular dependency
                // Or execute SQL directly if repo not available
                db.prepare(`
                   UPDATE campaigns 
                   SET party_moral_score = ?, party_ethical_score = ?
                   WHERE id = ?
               `).run(updated.moral_score, updated.ethical_score, campaignId);
            }
        }
    },

    /**
     * Clears REPUTATION_CHANGE events for a given (campaign, faction, session)
     * and reverses their effects on the reputation score. Provides idempotency
     * so re-processing a session doesn't double-count reputation changes.
     */
    clearSessionFactionEvents: (campaignId: number, factionName: string, sessionId: string): void => {
        db.transaction(() => {
            // 1. Sum up existing reputation changes for this session+faction
            const row = db.prepare(`
                SELECT COALESCE(SUM(reputation_change_value), 0) as total_rep,
                       COALESCE(SUM(moral_weight), 0) as total_moral,
                       COALESCE(SUM(ethical_weight), 0) as total_ethical
                FROM faction_history
                WHERE campaign_id = ? AND lower(faction_name) = lower(?) AND session_id = ?
                  AND event_type = 'REPUTATION_CHANGE'
            `).get(campaignId, factionName, sessionId) as { total_rep: number; total_moral: number; total_ethical: number } | undefined;

            if (!row || (row.total_rep === 0 && row.total_moral === 0 && row.total_ethical === 0)) {
                // Also delete the rows even if totals are zero
                db.prepare(`
                    DELETE FROM faction_history
                    WHERE campaign_id = ? AND lower(faction_name) = lower(?) AND session_id = ?
                      AND event_type = 'REPUTATION_CHANGE'
                `).run(campaignId, factionName, sessionId);
                return;
            }

            // 2. Reverse reputation score
            if (row.total_rep !== 0) {
                const faction = factionRepository.getFaction(campaignId, factionName);
                if (faction && !faction.is_party) {
                    db.prepare(`
                        UPDATE faction_reputation
                        SET reputation_score = MIN(50, MAX(-50, COALESCE(reputation_score, 0) - $reversal)),
                            last_updated = CURRENT_TIMESTAMP
                        WHERE campaign_id = $campaignId AND faction_id = $factionId
                    `).run({ campaignId, factionId: faction.id, reversal: row.total_rep });

                    // Re-derive label
                    const updated = db.prepare(`
                        SELECT reputation_score FROM faction_reputation
                        WHERE campaign_id = ? AND faction_id = ?
                    `).get(campaignId, faction.id) as { reputation_score: number } | undefined;

                    const newScore = updated?.reputation_score ?? 0;
                    const newLabel = getReputationLabel(newScore);
                    db.prepare(`
                        UPDATE faction_reputation SET reputation = ? WHERE campaign_id = ? AND faction_id = ?
                    `).run(newLabel, campaignId, faction.id);
                }
            }

            // 3. Delete the history rows
            db.prepare(`
                DELETE FROM faction_history
                WHERE campaign_id = ? AND lower(faction_name) = lower(?) AND session_id = ?
                  AND event_type = 'REPUTATION_CHANGE'
            `).run(campaignId, factionName, sessionId);

            console.log(`[Faction] 🔄 Cleared session ${sessionId} REPUTATION_CHANGE events for ${factionName} (reversed rep: ${row.total_rep})`);
        })();
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
                    // Conflict: Combine notes, keep role with highest priority
                    const newNotes = (conflict.notes || '') + (aff.notes ? '\n[Fusa] ' + aff.notes : '');
                    const sourcePriority = ROLE_PRIORITY[aff.role] ?? 0;
                    const targetPriority = ROLE_PRIORITY[conflict.role] ?? 0;
                    const bestRole = sourcePriority > targetPriority ? aff.role : conflict.role;
                    db.prepare(`
                        UPDATE faction_affiliations
                        SET notes = ?, is_active = MAX(is_active, ?), role = ?
                        WHERE id = ?
                    `).run(newNotes, aff.is_active, bestRole, conflict.id);

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
            if (targetRep === 'NEUTRAL' && sourceRep !== 'NEUTRAL') {
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
    // COMPUTED ALIGNMENT (On-Demand)
    // =============================================

    /**
     * Computes faction alignment from:
     * 1. Faction's own events (faction_history)
     * 2. Member NPCs' events (npc_history), weighted by role
     *
     * @returns { moralScore, ethicalScore, moralLabel, ethicalLabel, breakdown }
     */
    getComputedFactionAlignment: (campaignId: number, factionId: number): {
        moralScore: number;
        ethicalScore: number;
        moralLabel: string;
        ethicalLabel: string;
        breakdown: {
            factionMoral: number;
            factionEthical: number;
            membersMoral: number;
            membersEthical: number;
            memberCount: number;
        };
    } => {
        // 1. Get faction's own events contribution
        const faction = factionRepository.getFactionById(factionId);
        if (!faction) {
            return {
                moralScore: 0,
                ethicalScore: 0,
                moralLabel: 'NEUTRAL',
                ethicalLabel: 'NEUTRAL',
                breakdown: { factionMoral: 0, factionEthical: 0, membersMoral: 0, membersEthical: 0, memberCount: 0 }
            };
        }

        const factionEvents = db.prepare(`
            SELECT COALESCE(SUM(moral_weight), 0) as total_moral,
                   COALESCE(SUM(ethical_weight), 0) as total_ethical
            FROM faction_history
            WHERE campaign_id = ? AND lower(faction_name) = lower(?)
        `).get(campaignId, faction.name) as { total_moral: number; total_ethical: number };

        const factionMoral = factionEvents.total_moral || 0;
        const factionEthical = factionEvents.total_ethical || 0;

        // 2. Get all active NPC members with their roles
        const npcMembers = db.prepare(`
            SELECT fa.entity_id, fa.role, n.name as npc_name
            FROM faction_affiliations fa
            JOIN npc_dossier n ON fa.entity_id = n.id
            WHERE fa.faction_id = ?
              AND fa.entity_type = 'npc'
              AND fa.is_active = 1
        `).all(factionId) as Array<{ entity_id: number; role: string; npc_name: string }>;

        // 2b. Get all active PC members with their roles
        const pcMembers = db.prepare(`
            SELECT fa.entity_id, fa.role, c.character_name
            FROM faction_affiliations fa
            JOIN characters c ON fa.entity_id = c.rowid
            WHERE fa.faction_id = ?
              AND fa.entity_type = 'pc'
              AND fa.is_active = 1
        `).all(factionId) as Array<{ entity_id: number; role: string; character_name: string }>;

        // 3. Calculate weighted contribution from each member
        let membersMoral = 0;
        let membersEthical = 0;
        let validMemberCount = 0;

        // Process NPCs
        for (const member of npcMembers) {
            const roleWeight = ROLE_WEIGHTS[member.role] ?? 0;
            if (roleWeight === 0) continue;
            validMemberCount++;

            // Get NPC's events
            const npcEvents = db.prepare(`
                SELECT COALESCE(SUM(moral_weight), 0) as total_moral,
                       COALESCE(SUM(ethical_weight), 0) as total_ethical
                FROM npc_history
                WHERE campaign_id = ? AND lower(npc_name) = lower(?)
            `).get(campaignId, member.npc_name) as { total_moral: number; total_ethical: number };

            membersMoral += (npcEvents.total_moral || 0) * roleWeight;
            membersEthical += (npcEvents.total_ethical || 0) * roleWeight;
        }

        // Process PCs
        for (const member of pcMembers) {
            const roleWeight = ROLE_WEIGHTS[member.role] ?? 0;
            if (roleWeight === 0) continue;
            validMemberCount++;

            // Get PC's events
            const pcEvents = db.prepare(`
                SELECT COALESCE(SUM(moral_weight), 0) as total_moral,
                       COALESCE(SUM(ethical_weight), 0) as total_ethical
                FROM character_history
                WHERE campaign_id = ? AND lower(character_name) = lower(?)
            `).get(campaignId, member.character_name) as { total_moral: number; total_ethical: number };

            membersMoral += (pcEvents.total_moral || 0) * roleWeight;
            membersEthical += (pcEvents.total_ethical || 0) * roleWeight;
        }

        // 4. Sum totals
        const totalMoral = Math.round(factionMoral + membersMoral);
        const totalEthical = Math.round(factionEthical + membersEthical);

        return {
            moralScore: totalMoral,
            ethicalScore: totalEthical,
            moralLabel: getMoralAlignment(totalMoral),
            ethicalLabel: getEthicalAlignment(totalEthical),
            breakdown: {
                factionMoral,
                factionEthical,
                membersMoral: Math.round(membersMoral),
                membersEthical: Math.round(membersEthical),
                memberCount: validMemberCount
            }
        };
    },

    // =============================================
    // SEARCH
    // =============================================

    findFactionByName: (campaignId: number, query: string): FactionEntry[] => {
        // Normalizza la query rimuovendo articoli comuni se all'inizio (opzionale, ma aiuta)
        // Per ora usiamo un approccio SQL bidirezionale
        return db.prepare(`
            SELECT * FROM factions
            WHERE campaign_id = $campaignId 
            AND (
                lower(name) LIKE '%' || lower($query) || '%' -- Name contains Query (es. "Culto del Drago" trova "Culto")
                OR (
                   length(name) > 3 
                   AND lower($query) LIKE '%' || lower(name) || '%' -- Query contains Name (es. "il Culto" trova "Culto")
                )
            )
            LIMIT 5
        `).all({ campaignId, query }) as FactionEntry[];
    }
};
