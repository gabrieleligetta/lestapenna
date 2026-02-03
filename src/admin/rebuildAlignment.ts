
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
    getEthicalAlignment as getEthicalLabel
} from '../utils/alignmentUtils';

const getReputationLabel = (score: number): ReputationLevel => {
    // Score range assumed: -100 to +100
    // -50: Hostile
    // -25: Diffident
    // -10: Cold
    // -10 to +10: Neutral
    // +10: Cordial
    // +25: Friendly
    // +50: Ally
    if (score <= -50) return 'OSTILE';
    if (score <= -25) return 'DIFFIDENTE';
    if (score <= -10) return 'FREDDO';
    if (score >= 50) return 'ALLEATO';
    if (score >= 25) return 'AMICHEVOLE';
    if (score >= 10) return 'CORDIALE';
    return 'NEUTRALE';
};

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
            // Fetch all history with weights
            const history = db.prepare(`
                SELECT moral_weight, ethical_weight 
                FROM character_history 
                WHERE campaign_id = ? AND character_name = ?
            `).all(campaignId, char.character_name) as { moral_weight: number, ethical_weight: number }[];

            let moralScore = 0;
            let ethicalScore = 0;

            for (const event of history) {
                moralScore += event.moral_weight || 0;
                ethicalScore += event.ethical_weight || 0;
            }

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
            const history = db.prepare(`
                SELECT moral_weight, ethical_weight 
                FROM npc_history 
                WHERE campaign_id = ? AND npc_name = ?
            `).all(campaignId, npc.name) as { moral_weight: number, ethical_weight: number }[];

            let moralScore = 0;
            let ethicalScore = 0;

            for (const event of history) {
                moralScore += event.moral_weight || 0;
                ethicalScore += event.ethical_weight || 0;
            }

            const moralLabel = getMoralLabel(moralScore);
            const ethicalLabel = getEthicalLabel(ethicalScore);

            db.prepare(`
                UPDATE npc_dossier 
                SET moral_score = ?, ethical_score = ?, alignment_moral = ?, alignment_ethical = ?
                WHERE id = ?
            `).run(moralScore, ethicalScore, moralLabel, ethicalLabel, npc.id);

            // Only log significant changes or non-neutral to avoid spam? No, log all for debug.
            if (history.length > 0) {
                logs.push(`🤖 ${npc.name}: ${moralLabel} ${ethicalLabel} (M: ${moralScore}, E: ${ethicalScore})`);
            }
        }
    },

    async rebuildFactions(campaignId: number, logs: string[]) {
        const factions = db.prepare('SELECT id, name, is_party FROM factions WHERE campaign_id = ?').all(campaignId) as { id: number, name: string, is_party: number }[];

        for (const faction of factions) {
            // Get Faction History
            // faction_history usually tracks interaction WITH the faction.
            // But if it's the Party Faction, it tracks the Party's deeds.

            const history = db.prepare(`
                SELECT moral_weight, ethical_weight, reputation_change_value 
                FROM faction_history 
                WHERE campaign_id = ? AND faction_name = ?
            `).all(campaignId, faction.name) as { moral_weight: number, ethical_weight: number, reputation_change_value: number }[];

            let moralScore = 0;
            let ethicalScore = 0;
            let reputationScore = 0;

            for (const event of history) {
                // For Party Faction, Weights apply to the Faction itself (The Party)
                // For Other Factions, Weights MIGHT apply to them if they did something?
                // OR weights in faction_history always mean "Action performed BY this faction or related to it".
                // Let's assume weights apply to the faction's alignment.
                moralScore += event.moral_weight || 0;
                ethicalScore += event.ethical_weight || 0;

                // Reputation change applies to relationship with Party
                reputationScore += event.reputation_change_value || 0;
            }

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

                if (history.length > 0) {
                    logs.push(`🏛️ ${faction.name}: Rep ${repLabel} (${reputationScore}), Align ${moralLabel} ${ethicalLabel}`);
                }
            }
        }
    }
};
