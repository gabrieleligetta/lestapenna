
import { db } from '../db/client';
import {
    campaignRepository,
    characterRepository,
    npcRepository,
    factionRepository
} from '../db';
import {
    UserProfile,
    NpcEntry,
    FactionEntry,
    ReputationLevel,
    REPUTATION_SPECTRUM
} from '../db/types';

import {
    getMoralAlignment as getMoralLabel,
    getEthicalAlignment as getEthicalLabel,
    getReputationLabel,
    computeAggregatedAlignmentScore
} from '../utils/alignmentUtils';

export const rebuildAlignment = {
    /**
     * Rebuilds all alignment scores for a campaign
     */
    async rebuildAll(campaignId: number): Promise<string[]> {
        const logs: string[] = [];
        logs.push(`🔧 Avvio ricostruzione allineamento per campagna ${campaignId}...`);

        // 1. Characters
        await this.rebuildCharacters(campaignId, logs);

        // 2. NPCs
        await this.rebuildNpcs(campaignId, logs);

        // 3. Factions & Party
        await this.rebuildFactions(campaignId, logs);

        logs.push(`✅ Ricostruzione completata.`);
        return logs;
    },

    async rebuildCharacters(campaignId: number, logs: string[]) {
        const characters = characterRepository.getCampaignCharacters(campaignId);
        for (const char of characters) {
            const rows = db.prepare(`
                SELECT moral_weight, ethical_weight
                FROM character_history
                WHERE campaign_id = ? AND character_name = ?
                AND (moral_weight != 0 OR ethical_weight != 0)
            `).all(campaignId, char.character_name) as { moral_weight: number; ethical_weight: number }[];

            const moralScore = computeAggregatedAlignmentScore(rows.map(r => r.moral_weight));
            const ethicalScore = computeAggregatedAlignmentScore(rows.map(r => r.ethical_weight));

            const moralLabel = getMoralLabel(moralScore);
            const ethicalLabel = getEthicalLabel(ethicalScore);

            // Update DB
            db.prepare(`
                UPDATE characters 
                SET moral_score = ?, ethical_score = ?, alignment_moral = ?, alignment_ethical = ?
                WHERE user_id = ? AND campaign_id = ?
            `).run(moralScore, ethicalScore, moralLabel, ethicalLabel, char.user_id, campaignId);

            logs.push(`👤 ${char.character_name}: ${moralLabel} ${ethicalLabel} (Moral: ${moralScore}, Ethical: ${ethicalScore})`);
        }
    },

    async rebuildNpcs(campaignId: number, logs: string[]) {
        const npcs = db.prepare('SELECT id, name FROM npc_dossier WHERE campaign_id = ?').all(campaignId) as { id: number, name: string }[];

        for (const npc of npcs) {
            const rows = db.prepare(`
                SELECT moral_weight, ethical_weight
                FROM npc_history
                WHERE campaign_id = ? AND npc_name = ?
                AND (moral_weight != 0 OR ethical_weight != 0)
            `).all(campaignId, npc.name) as { moral_weight: number; ethical_weight: number }[];

            const moralScore = computeAggregatedAlignmentScore(rows.map(r => r.moral_weight));
            const ethicalScore = computeAggregatedAlignmentScore(rows.map(r => r.ethical_weight));

            const moralLabel = getMoralLabel(moralScore);
            const ethicalLabel = getEthicalLabel(ethicalScore);

            db.prepare(`
                UPDATE npc_dossier
                SET moral_score = ?, ethical_score = ?, alignment_moral = ?, alignment_ethical = ?
                WHERE id = ?
            `).run(moralScore, ethicalScore, moralLabel, ethicalLabel, npc.id);

            if (rows.length > 0) {
                logs.push(`🤖 ${npc.name}: ${moralLabel} ${ethicalLabel} (M: ${moralScore}, E: ${ethicalScore})`);
            }
        }
    },

    async rebuildFactions(campaignId: number, logs: string[]) {
        const factions = db.prepare('SELECT id, name, is_party FROM factions WHERE campaign_id = ?').all(campaignId) as { id: number, name: string, is_party: number }[];

        for (const faction of factions) {
            // Alignment weights: same narrow filter as NpcRepository/CharacterRepository/
            // FactionRepository.recomputeFactionAlignment, so all entity types behave the same way
            // (previously this admin rebuild also folded in reputation-only rows, diluting the
            // average toward neutral in a way the live update path never did — aligned here).
            const alignRows = db.prepare(`
                SELECT moral_weight, ethical_weight
                FROM faction_history
                WHERE campaign_id = ? AND faction_name = ?
                AND (moral_weight != 0 OR ethical_weight != 0)
            `).all(campaignId, faction.name) as { moral_weight: number; ethical_weight: number }[];

            const repRow = db.prepare(`
                SELECT COALESCE(SUM(reputation_change_value), 0) as total_rep
                FROM faction_history
                WHERE campaign_id = ? AND faction_name = ?
            `).get(campaignId, faction.name) as { total_rep: number };

            const moralScore = computeAggregatedAlignmentScore(alignRows.map(r => r.moral_weight));
            const ethicalScore = computeAggregatedAlignmentScore(alignRows.map(r => r.ethical_weight));
            const reputationScore = repRow.total_rep || 0;

            const moralLabel = getMoralLabel(moralScore);
            const ethicalLabel = getEthicalLabel(ethicalScore);
            const repLabel = getReputationLabel(reputationScore);

            // Update Faction Alignment
            db.prepare(`
                UPDATE factions 
                SET moral_score = ?, ethical_score = ?, alignment_moral = ?, alignment_ethical = ?
                WHERE id = ?
            `).run(moralScore, ethicalScore, moralLabel, ethicalLabel, faction.id);

            if (faction.is_party) {
                // Update Campaign Party Alignment
                db.prepare(`
                    UPDATE campaigns 
                    SET party_moral_score = ?, party_ethical_score = ?, party_alignment_moral = ?, party_alignment_ethical = ?
                    WHERE id = ?
                `).run(moralScore, ethicalScore, moralLabel, ethicalLabel, campaignId);

                logs.push(`🛡️ **PARTY ALIGNMENT**: ${moralLabel} ${ethicalLabel} (M: ${moralScore}, E: ${ethicalScore})`);
            } else {
                // Update Reputation Score
                // We assume default reputation starts at 0? Or do we have a base?
                // Let's just set the score.

                // Ensure reputation entry exists
                db.prepare(`
                    INSERT INTO faction_reputation (campaign_id, faction_id, reputation, reputation_score)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(campaign_id, faction_id) DO UPDATE SET
                    reputation = excluded.reputation,
                    reputation_score = excluded.reputation_score
                `).run(campaignId, faction.id, repLabel, reputationScore);

                logs.push(`🏛️ ${faction.name}: Rep ${repLabel} (${reputationScore}), Align ${moralLabel} ${ethicalLabel}`);
            }
        }
    }
};
