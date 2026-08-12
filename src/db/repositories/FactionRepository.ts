import { db } from '../client';
import { getByShortId, recomputeAlignmentForHistory, resolveEntityId, getHistoryByEntity } from './shared';
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
import { getMoralAlignment, getEthicalAlignment, ROLE_PRIORITY, getReputationLabel, getReputationScoreForLabel, computeAggregatedAlignmentScore } from '../../utils/alignmentUtils';
import { knowledgeRepository } from './KnowledgeRepository';

export interface FactionMergeReport {
    historyRepointed: number;
    affiliationsRepointed: number;
    artifactsRepointed: number;
    ragFragmentsDeleted: number;
    ragRefsRewritten: number;
    shortIdRegenerated: boolean;
    manualPropagated: boolean;
}

function recomputeFactionAlignment(campaignId: number, factionName: string): void {
    // Shared aggregation + write-back (repositories/shared.ts): identical to
    // NPCs/PCs, and reused by the single-event edit/delete via the API too.
    recomputeAlignmentForHistory(campaignId, 'faction_history', factionName);
}

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
        return (db.prepare(`
            SELECT * FROM factions 
            WHERE campaign_id = ? AND lower(name) = lower(?)
        `).get(campaignId, name) as FactionEntry | undefined) ?? null;
    },

    getFactionById: (id: number): FactionEntry | null => {
        return (db.prepare('SELECT * FROM factions WHERE id = ?').get(id) as FactionEntry | undefined) ?? null;
    },

    getFactionByShortId: (campaignId: number, shortId: string): FactionEntry | null =>
        getByShortId<FactionEntry>('factions', campaignId, shortId),

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

        // Update history references (nome + entity_id)
        if (res.changes > 0) {
            const factionId = resolveEntityId('factions', 'name', campaignId, newName);
            db.prepare(`
                UPDATE faction_history
                SET faction_name = ?, entity_id = ?
                WHERE campaign_id = ?
                  AND (entity_id = ? OR (entity_id IS NULL AND lower(faction_name) = lower(?)))
            `).run(newName, factionId, campaignId, factionId, oldName);
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

    // `faction_short_id` is additive — existing callers read faction_name only —
    // and is what lets a client link an affiliation back to the faction's page.
    getEntityFactions: (entityType: AffiliationEntityType, entityId: number, activeOnly: boolean = true): Array<FactionAffiliation & { faction_short_id: string | null }> => {
        const query = activeOnly
            ? `SELECT fa.*, f.name as faction_name, f.short_id as faction_short_id
               FROM faction_affiliations fa
               JOIN factions f ON fa.faction_id = f.id
               WHERE fa.entity_type = ? AND fa.entity_id = ? AND fa.is_active = 1`
            : `SELECT fa.*, f.name as faction_name, f.short_id as faction_short_id
               FROM faction_affiliations fa
               JOIN factions f ON fa.faction_id = f.id
               WHERE fa.entity_type = ? AND fa.entity_id = ?`;

        return db.prepare(query).all(entityType, entityId) as Array<FactionAffiliation & { faction_short_id: string | null }>;
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

    /**
     * Faction members with the target's display name and short_id resolved.
     *
     * Kept apart from getFactionMembers, which is used by the bot's `$faction`
     * embed and renders a PC as the literal 'ID:7' — its CASE has no branch for
     * 'pc'. The short_id columns are what let the web link a member to its own
     * page; characters have none, so their user_id is carried instead.
     *
     * The 'pc' join goes through characters.rowid, which is how
     * faction_affiliations addresses characters (see the schema note in
     * un rowid implicito non è una foreign key dichiarata).
     */
    listFactionMembersDetailed: (
        factionId: number,
        activeOnly: boolean = true,
    ): Array<{
        entity_type: AffiliationEntityType;
        entity_id: number;
        role: AffiliationRole;
        is_active: number;
        notes: string | null;
        joined_session_id: string | null;
        name: string | null;
        short_id: string | null;
        user_id: string | null;
    }> => {
        const query = `
            SELECT fa.entity_type, fa.entity_id, fa.role, fa.is_active, fa.notes, fa.joined_session_id,
                   CASE
                     WHEN fa.entity_type = 'npc' THEN n.name
                     WHEN fa.entity_type = 'location' THEN a.macro_location || ' | ' || a.micro_location
                     WHEN fa.entity_type = 'pc' THEN c.character_name
                   END as name,
                   CASE
                     WHEN fa.entity_type = 'npc' THEN n.short_id
                     WHEN fa.entity_type = 'location' THEN a.short_id
                   END as short_id,
                   c.user_id as user_id
            FROM faction_affiliations fa
            LEFT JOIN npc_dossier n ON fa.entity_type = 'npc' AND fa.entity_id = n.id
            LEFT JOIN location_atlas a ON fa.entity_type = 'location' AND fa.entity_id = a.id
            LEFT JOIN characters c ON fa.entity_type = 'pc' AND fa.entity_id = c.rowid
            WHERE fa.faction_id = ?${activeOnly ? ' AND fa.is_active = 1' : ''}
            ORDER BY fa.entity_type, name
        `;
        return db.prepare(query).all(factionId) as any[];
    },

    /**
     * Every faction with the party's standing toward it.
     *
     * Not getReputationWithAllFactions: that one forces is_party = 0 and is used
     * by manifesto.ts and hydration.ts, so widening it would change what the AI
     * sees. The party faction itself is excluded here too — you have no standing
     * with yourself — but as a decision this endpoint owns.
     */
    listFactionsWithReputation: (campaignId: number): Array<FactionEntry & { reputation: ReputationLevel }> => {
        return db.prepare(`
            SELECT f.*, COALESCE(fr.reputation, 'NEUTRAL') as reputation
            FROM factions f
            LEFT JOIN faction_reputation fr ON f.id = fr.faction_id AND fr.campaign_id = f.campaign_id
            WHERE f.campaign_id = ?
            ORDER BY f.is_party DESC, f.name
        `).all(campaignId) as Array<FactionEntry & { reputation: ReputationLevel }>;
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
            // 1. Insert Event (entity_id: a stable link to the faction, it survives renames)
            const entityId = resolveEntityId('factions', 'name', campaignId, factionName);
            db.prepare(`
                INSERT INTO faction_history (campaign_id, faction_name, session_id, event_type, description, timestamp, is_manual, reputation_change_value, moral_weight, ethical_weight, entity_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                ethicalWeight,
                entityId
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

            // 3. Update Alignment Scores: average of the non-zero weights only * 10.
            // Neutral events do NOT enter the denominator: they are the bulk of
            // the history, and counting them would make every faction converge
            // on NEUTRAL as it gets mentioned (see
            // computeAggregatedAlignmentScore and alignment_average.test.ts).
            recomputeFactionAlignment(campaignId, factionName);
        })();
    },

    /**
     * Updates faction alignment by recording a member contribution and recomputing the average.
     */
    updateFactionAlignmentScore: (campaignId: number, factionId: number, moralDelta: number, ethicalDelta: number): void => {
        const faction = factionRepository.getFactionById(factionId);
        if (!faction) return;

        // Record the member contribution in faction_history so avg is consistent
        // (entity_id included: it used to stay NULL and id-based reads lost it)
        db.prepare(`
            INSERT INTO faction_history (campaign_id, faction_name, session_id, event_type, description, timestamp, is_manual, reputation_change_value, moral_weight, ethical_weight, entity_id)
            VALUES (?, ?, NULL, 'GENERIC', 'Contributo membro', ?, 0, 0, ?, ?, ?)
        `).run(campaignId, faction.name, Date.now(), moralDelta, ethicalDelta, factionId);

        recomputeFactionAlignment(campaignId, faction.name);
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
                       COALESCE(SUM(ethical_weight), 0) as total_ethical,
                       COUNT(*) as cnt
                FROM faction_history
                WHERE campaign_id = ? AND lower(faction_name) = lower(?) AND session_id = ?
                  AND event_type = 'REPUTATION_CHANGE'
            `).get(campaignId, factionName, sessionId) as { total_rep: number; total_moral: number; total_ethical: number; cnt: number } | undefined;

            if (!row || row.cnt === 0) {
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

            // 4. Recompute alignment avg from remaining events. With avg-based scores,
            // deleting rows can change the denominator even when deleted weights sum to zero.
            recomputeFactionAlignment(campaignId, factionName);

            console.log(`[Faction] 🔄 Cleared session ${sessionId} REPUTATION_CHANGE events for ${factionName} (reversed rep: ${row.total_rep})`);
        })();
    },

    getFactionHistory: (campaignId: number, factionName: string): FactionHistoryEntry[] => {
        return getHistoryByEntity<FactionHistoryEntry>(
            'faction_history', 'faction_name', 'factions', 'name', campaignId, factionName);
    },

    // =============================================
    // MERGE
    // =============================================
    mergeFactionsById: (
        campaignId: number,
        sourceId: number,
        targetId: number,
        mergedDescription?: string
    ): FactionMergeReport | null => {
        const source = factionRepository.getFactionById(sourceId);
        const target = factionRepository.getFactionById(targetId);

        if (!source || !target || source.campaign_id !== campaignId || target.campaign_id !== campaignId) {
            return null;
        }
        if (source.id === target.id || source.is_party === 1 || target.is_party === 1) return null;

        const report: FactionMergeReport = {
            historyRepointed: 0,
            affiliationsRepointed: 0,
            artifactsRepointed: 0,
            ragFragmentsDeleted: 0,
            ragRefsRewritten: 0,
            shortIdRegenerated: Boolean(
                source.short_id && target.short_id && source.short_id === target.short_id,
            ),
            manualPropagated: target.is_manual !== 1 && source.is_manual === 1,
        };

        db.transaction(() => {
            // 1. The survivor keeps its own fields; an explicit description wins,
            // otherwise a description from the loser only fills the gap.
            const description = mergedDescription?.trim()
                || target.description
                || source.description
                || null;
            const manualDescription = (target as any).manual_description
                || (source as any).manual_description
                || (report.manualPropagated ? source.description : null);
            db.prepare(`
                UPDATE factions
                SET description = ?,
                    rag_sync_needed = 1,
                    last_updated = CURRENT_TIMESTAMP,
                    is_manual = CASE WHEN ? THEN 1 ELSE is_manual END,
                    manual_description = CASE WHEN ? THEN COALESCE(?, manual_description) ELSE manual_description END
                WHERE id = ?
            `).run(
                description,
                report.manualPropagated ? 1 : 0,
                report.manualPropagated ? 1 : 0,
                manualDescription,
                target.id,
            );

            if (report.shortIdRegenerated) {
                db.prepare('UPDATE factions SET short_id = ? WHERE id = ?')
                    .run(generateShortId('factions'), target.id);
            }

            // 2. Move History (nome + entity_id → target)
            const history = db.prepare(`
                UPDATE faction_history
                SET faction_name = ?, entity_id = ?
                WHERE campaign_id = ?
                  AND (entity_id = ? OR (entity_id IS NULL AND lower(faction_name) = lower(?)))
            `).run(target.name, target.id, campaignId, source.id, source.name);
            report.historyRepointed = history.changes;

            // 3. Move Affiliations (uses faction_id)
            // Handle unique constraint manually to avoid losing metadata if possible
            const sourceAffiliations = db.prepare('SELECT * FROM faction_affiliations WHERE faction_id = ?').all(source.id) as FactionAffiliation[];

            for (const aff of sourceAffiliations) {
                const conflict = db.prepare(`
                    SELECT id, role, notes, is_active, joined_session_id
                    FROM faction_affiliations 
                    WHERE faction_id = ? AND entity_type = ? AND entity_id = ?
                `).get(target.id, aff.entity_type, aff.entity_id) as FactionAffiliation | undefined;

                if (conflict) {
                    // Conflict: Combine notes, keep role with highest priority
                    const newNotes = [
                        conflict.notes,
                        aff.notes ? `[Fusa da ${source.name}] ${aff.notes}` : null,
                    ].filter(Boolean).join('\n') || null;
                    const sourcePriority = ROLE_PRIORITY[aff.role] ?? 0;
                    const targetPriority = ROLE_PRIORITY[conflict.role] ?? 0;
                    const bestRole = sourcePriority > targetPriority ? aff.role : conflict.role;
                    db.prepare(`
                        UPDATE faction_affiliations
                        SET notes = ?,
                            is_active = MAX(is_active, ?),
                            role = ?,
                            joined_session_id = COALESCE(joined_session_id, ?)
                        WHERE id = ?
                    `).run(newNotes, aff.is_active, bestRole, aff.joined_session_id, conflict.id);

                    // Delete source affiliation
                    db.prepare('DELETE FROM faction_affiliations WHERE id = ?').run(aff.id);
                } else {
                    // No conflict: just reassign
                    db.prepare('UPDATE faction_affiliations SET faction_id = ? WHERE id = ?').run(target.id, aff.id);
                }
                report.affiliationsRepointed++;
            }

            // 4. Move Artifacts
            const artifacts = db.prepare(`
                UPDATE artifacts 
                SET faction_id = ? 
                WHERE campaign_id = ? AND faction_id = ?
            `).run(target.id, campaignId, source.id);
            report.artifactsRepointed = artifacts.changes;

            // 5. If the survivor is neutral, keep the loser's explicit reputation
            // if any; otherwise the survivor stays authoritative.
            const sourceRep = factionRepository.getFactionReputation(campaignId, source.id);
            const targetRep = factionRepository.getFactionReputation(campaignId, target.id);
            if (targetRep === 'NEUTRAL' && sourceRep !== 'NEUTRAL') {
                factionRepository.setFactionReputation(campaignId, target.id, sourceRep);
            }

            // 6. Memory: merge the cards into a single chronological fragment and
            // repoint both the legacy JSON name and the typed faction:<id> refs.
            report.ragFragmentsDeleted = knowledgeRepository.mergeEntityRagSnapshots(
                campaignId,
                'FACTION_UPDATE',
                `[[SCHEDA FAZIONE UFFICIALE: ${source.name}]]`,
                `[[SCHEDA FAZIONE UFFICIALE: ${target.name}]]`,
            );
            report.ragRefsRewritten += knowledgeRepository.rewriteFactionRagAssociatedRefs(
                campaignId,
                source.name,
                target.name,
            );
            report.ragRefsRewritten += knowledgeRepository.rewriteTypedEntityRagRefs(
                campaignId,
                'faction',
                source.id,
                target.id,
            );

            // 7. Delete source faction (reputation residua in CASCADE).
            db.prepare('DELETE FROM factions WHERE id = ?').run(source.id);

            // A unified history = the alignment recomputed on the survivor.
            recomputeFactionAlignment(campaignId, target.name);
        })();

        try {
            const { invalidateEntityVectors } = require('../../bard/reconciliation/semantic');
            invalidateEntityVectors(campaignId);
        } catch (error) {
            console.warn('[Faction] ⚠️ invalidateEntityVectors non disponibile (skip):', (error as Error).message);
        }

        console.log(`[Faction] 🔀 Merged: ${source.name} -> ${target.name}`);
        return report;
    },

    /** Compatibility for the existing bot commands; the web path uses stable IDs. */
    mergeFactions: (
        campaignId: number,
        sourceName: string,
        targetName: string,
        mergedDescription?: string
    ): boolean => {
        const source = factionRepository.getFaction(campaignId, sourceName);
        const target = factionRepository.getFaction(campaignId, targetName);
        if (!source || !target) return false;
        return Boolean(factionRepository.mergeFactionsById(
            campaignId,
            source.id,
            target.id,
            mergedDescription,
        ));
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
     * Returns the canonical persisted faction alignment.
     * Alignment is avg-based over faction_history and maintained by addFactionEvent/rebuildAlignment.
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

        const totalMoral = faction.moral_score || 0;
        const totalEthical = faction.ethical_score || 0;

        return {
            moralScore: totalMoral,
            ethicalScore: totalEthical,
            moralLabel: getMoralAlignment(totalMoral),
            ethicalLabel: getEthicalAlignment(totalEthical),
            breakdown: {
                factionMoral: totalMoral,
                factionEthical: totalEthical,
                membersMoral: 0,
                membersEthical: 0,
                memberCount: 0
            }
        };
    },

    // =============================================
    // SEARCH
    // =============================================

    findFactionByName: (campaignId: number, query: string): FactionEntry[] => {
        // Normalize the query by stripping leading common articles (optional, but it helps)
        // For now we use a bidirectional SQL approach
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
