/**
 * Tests for the average-based alignment system.
 *
 * Core invariants:
 *   score = round(AVG(moral_weight over NON-ZERO weights) * 10)  → -100..+100
 *   GOOD if score >= 25, EVIL if score <= -25, else NEUTRAL
 *
 *   1 good event (+5)          → score +50  → GOOD
 *   5 identical good events    → score +50  → GOOD  (same as 1)
 *   1 good (+5) + 1 bad (-5)   → score  0   → NEUTRAL
 *   only neutral events (0)    → score  0   → NEUTRAL
 *   1 good (+5) + 1 neutral(0) → score +50  → GOOD  (the zero does not dilute)
 *
 * Zero-weight events are excluded from the average on purpose. They are the
 * absolute majority of the history rows — every appearance in a scene,
 * and every "member contribution" row with a zero delta written by
 * updateFactionAlignmentScore — so counting them would make the alignment a
 * function of how often the entity is mentioned, not of what it did:
 * an NPC with a single heroic act and fifty ordinary appearances would come out
 * NEUTRAL. The rule lives in computeAggregatedAlignmentScore
 * (utils/alignmentUtils.ts) and in the SQL filter of computeAlignmentFromHistory.
 */

import { randomUUID as uuidv4 } from 'crypto';
import { wipeDatabase } from '../../../src/db/maintenance';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { npcRepository } from '../../../src/db/repositories/NpcRepository';
import { characterRepository } from '../../../src/db/repositories/CharacterRepository';
import { factionRepository } from '../../../src/db/repositories/FactionRepository';
import { rebuildAlignment } from '../../../src/admin/rebuildAlignment';
import { db } from '../../../src/db';

const GUILD = 'test_align_avg';
let campaignId: number;
let sessionId: string;

function createNpc(name: string) {
    npcRepository.updateNpcEntry(campaignId, name, 'Test NPC', undefined, undefined, sessionId);
}

function createCharacter(userId: string, name: string) {
    characterRepository.updateUserCharacter(userId, campaignId, 'character_name', name);
}

function npcScore(name: string) {
    return npcRepository.getNpcEntry(campaignId, name) as { moral_score: number; ethical_score: number; alignment_moral: string; alignment_ethical: string };
}

function charScore(name: string) {
    return db.prepare(
        'SELECT moral_score, ethical_score, alignment_moral, alignment_ethical FROM characters WHERE campaign_id = ? AND lower(character_name) = lower(?)'
    ).get(campaignId, name) as { moral_score: number; ethical_score: number; alignment_moral: string; alignment_ethical: string } | undefined;
}

function factionScore(name: string) {
    return factionRepository.getFaction(campaignId, name) as { moral_score: number; ethical_score: number; alignment_moral: string; alignment_ethical: string } | undefined;
}

beforeAll(() => {
    wipeDatabase();
    campaignId = campaignRepository.createCampaign(GUILD, 'Alignment Avg Campaign');
    sessionId = uuidv4();
});

afterAll(() => {
    wipeDatabase();
});

// ─────────────────────────────────────────────
// NPC alignment
// ─────────────────────────────────────────────

describe('NPC alignment – average formula', () => {
    it('1 good event → GOOD', () => {
        createNpc('Leosin');
        npcRepository.addNpcEvent(campaignId, 'Leosin', sessionId, 'Salva un innocente', 'ACHIEVEMENT', false, undefined, 5, 0);
        const s = npcScore('Leosin');
        expect(s.moral_score).toBe(50);   // round(5 * 10)
        expect(s.alignment_moral).toBe('GOOD');
    });

    it('5 identical good events → same score as 1 (avg unchanged)', () => {
        createNpc('Tabita');
        for (let i = 0; i < 5; i++) {
            npcRepository.addNpcEvent(campaignId, 'Tabita', sessionId, 'Atto buono', 'ACHIEVEMENT', false, undefined, 5, 0);
        }
        const s = npcScore('Tabita');
        expect(s.moral_score).toBe(50);   // avg still 5, *10 = 50
        expect(s.alignment_moral).toBe('GOOD');
    });

    it('1 good (+5) + 1 bad (-5) → NEUTRAL', () => {
        createNpc('Ivonne');
        npcRepository.addNpcEvent(campaignId, 'Ivonne', sessionId, 'Aiuta il party', 'ALLIANCE', false, undefined, 5, 0);
        npcRepository.addNpcEvent(campaignId, 'Ivonne', sessionId, 'Tradisce il party', 'BETRAYAL', false, undefined, -5, 0);
        const s = npcScore('Ivonne');
        expect(s.moral_score).toBe(0);
        expect(s.alignment_moral).toBe('NEUTRAL');
    });

    it('only neutral events → NEUTRAL', () => {
        createNpc('Guardiano');
        npcRepository.addNpcEvent(campaignId, 'Guardiano', sessionId, 'Interazione neutra', 'INTERACTION', false, undefined, 0, 0);
        const s = npcScore('Guardiano');
        expect(s.moral_score).toBe(0);
        expect(s.alignment_moral).toBe('NEUTRAL');
    });

    it('1 evil event (-8) → EVIL', () => {
        createNpc('Cultista');
        npcRepository.addNpcEvent(campaignId, 'Cultista', sessionId, 'Massacra civili', 'DEATH', false, undefined, -8, -6);
        const s = npcScore('Cultista');
        expect(s.moral_score).toBe(-80);
        expect(s.ethical_score).toBe(-60);
        expect(s.alignment_moral).toBe('EVIL');
        expect(s.alignment_ethical).toBe('CHAOTIC');
    });

    it('both axes tracked independently', () => {
        createNpc('Giudice');
        // Morally bad but ethically lawful (follows the law to do evil)
        npcRepository.addNpcEvent(campaignId, 'Giudice', sessionId, 'Condanna ingiusta per legge', 'STATUS_CHANGE', false, undefined, -4, 6);
        const s = npcScore('Giudice');
        expect(s.moral_score).toBe(-40);
        expect(s.ethical_score).toBe(60);
        expect(s.alignment_moral).toBe('EVIL');
        expect(s.alignment_ethical).toBe('LAWFUL');
    });

    it('neutral events do not dilute the average', () => {
        createNpc('Cronista');
        npcRepository.addNpcEvent(campaignId, 'Cronista', sessionId, 'Salva un innocente', 'ACHIEVEMENT', false, undefined, 5, 0);
        npcRepository.addNpcEvent(campaignId, 'Cronista', sessionId, 'Osserva senza intervenire', 'INTERACTION', false, undefined, 0, 0);
        const s = npcScore('Cronista');
        // Only the +5 enters the average: an appearance with no moral choices does not
        // make the NPC any less good.
        expect(s.moral_score).toBe(50);
        expect(s.alignment_moral).toBe('GOOD');
    });

    it('clamps extreme averaged scores to the canonical range', () => {
        createNpc('Abisso');
        npcRepository.addNpcEvent(campaignId, 'Abisso', sessionId, 'Atrocità assoluta', 'DEATH', false, undefined, -25, 25);
        const s = npcScore('Abisso');
        expect(s.moral_score).toBe(-100);
        expect(s.ethical_score).toBe(100);
        expect(s.alignment_moral).toBe('EVIL');
        expect(s.alignment_ethical).toBe('LAWFUL');
    });
});

// ─────────────────────────────────────────────
// Character alignment
// ─────────────────────────────────────────────

describe('Character alignment – average formula', () => {
    it('1 good event → GOOD', () => {
        const userId = 'user_aldric';
        createCharacter(userId, 'Aldric');
        characterRepository.addCharacterEvent(campaignId, 'Aldric', sessionId, 'Sacrificio eroico', 'ACHIEVEMENT', false, undefined, 7, 3);
        const s = charScore('Aldric');
        expect(s?.moral_score).toBe(70);
        expect(s?.alignment_moral).toBe('GOOD');
        expect(s?.ethical_score).toBe(30);
        expect(s?.alignment_ethical).toBe('LAWFUL');
    });

    it('good + bad events average to NEUTRAL', () => {
        const userId = 'user_vael';
        createCharacter(userId, 'Vael');
        characterRepository.addCharacterEvent(campaignId, 'Vael', sessionId, 'Salva un innocente', 'ACHIEVEMENT', false, undefined, 6, 0);
        characterRepository.addCharacterEvent(campaignId, 'Vael', sessionId, 'Uccide un prigioniero', 'TRAUMA', false, undefined, -6, 0);
        const s = charScore('Vael');
        expect(s?.moral_score).toBe(0);
        expect(s?.alignment_moral).toBe('NEUTRAL');
    });

    it('updates character labels immediately after inserting an event', () => {
        const userId = 'user_mira';
        createCharacter(userId, 'Mira');
        characterRepository.addCharacterEvent(campaignId, 'Mira', sessionId, 'Commette un tradimento grave', 'TRAUMA', false, undefined, -7, -6);
        const s = charScore('Mira');
        expect(s?.moral_score).toBe(-70);
        expect(s?.ethical_score).toBe(-60);
        expect(s?.alignment_moral).toBe('EVIL');
        expect(s?.alignment_ethical).toBe('CHAOTIC');
    });
});

// ─────────────────────────────────────────────
// Faction alignment
// ─────────────────────────────────────────────

describe('Faction alignment – average formula', () => {
    it('1 good faction event → GOOD', () => {
        factionRepository.createFaction(campaignId, 'Ordine della Luce', { description: 'Paladini', type: 'ORGANIZATION' });
        factionRepository.addFactionEvent(campaignId, 'Ordine della Luce', sessionId, 'Liberano il villaggio', 'GENERIC', false, 0, 8, 5);
        const s = factionScore('Ordine della Luce');
        expect(s?.moral_score).toBe(80);
        expect(s?.alignment_moral).toBe('GOOD');
        expect(s?.ethical_score).toBe(50);
        expect(s?.alignment_ethical).toBe('LAWFUL');
    });

    it('good + bad faction events → NEUTRAL', () => {
        factionRepository.createFaction(campaignId, 'Culto del Caos', { description: 'Neutrali', type: 'CULT' });
        factionRepository.addFactionEvent(campaignId, 'Culto del Caos', sessionId, 'Danno cibo ai poveri', 'GENERIC', false, 0, 5, 0);
        factionRepository.addFactionEvent(campaignId, 'Culto del Caos', sessionId, 'Sacrificano un membro', 'GENERIC', false, 0, -5, 0);
        const s = factionScore('Culto del Caos');
        expect(s?.moral_score).toBe(0);
        expect(s?.alignment_moral).toBe('NEUTRAL');
    });

    it('neutral faction events do not dilute the average', () => {
        factionRepository.createFaction(campaignId, 'Archivisti', { description: 'Osservatori', type: 'ORGANIZATION' });
        factionRepository.addFactionEvent(campaignId, 'Archivisti', sessionId, 'Proteggono un civile', 'GENERIC', false, 0, 5, 0);
        factionRepository.addFactionEvent(campaignId, 'Archivisti', sessionId, 'Registrano un evento senza intervenire', 'GENERIC', false, 0, 0, 0);
        const s = factionScore('Archivisti');
        expect(s?.moral_score).toBe(50);
        expect(s?.alignment_moral).toBe('GOOD');
    });

    it('clearSessionFactionEvents recomputes even when deleted weights sum to zero', () => {
        factionRepository.createFaction(campaignId, 'Guardia Grigia', { description: 'Milizia', type: 'ORGANIZATION' });
        factionRepository.addFactionEvent(campaignId, 'Guardia Grigia', sessionId, 'Aiutano il party', 'REPUTATION_CHANGE', false, 0, 5, 0);
        factionRepository.addFactionEvent(campaignId, 'Guardia Grigia', sessionId, 'Tradiscono il party', 'REPUTATION_CHANGE', false, 0, -5, 0);
        factionRepository.addFactionEvent(campaignId, 'Guardia Grigia', 'other-session', 'Proteggono i civili', 'GENERIC', false, 0, 5, 0);

        expect(factionScore('Guardia Grigia')?.moral_score).toBe(17);

        factionRepository.clearSessionFactionEvents(campaignId, 'Guardia Grigia', sessionId);

        const s = factionScore('Guardia Grigia');
        expect(s?.moral_score).toBe(50);
        expect(s?.alignment_moral).toBe('GOOD');
    });
});

// ─────────────────────────────────────────────
// rebuildAlignment recalculates from history
// ─────────────────────────────────────────────

describe('rebuildAlignment – avg formula', () => {
    it('rebuild produces same result as incremental path', async () => {
        createNpc('Mercante');
        // 3 good events, 1 bad
        npcRepository.addNpcEvent(campaignId, 'Mercante', sessionId, 'Dona', 'INTERACTION', false, undefined, 4, 0);
        npcRepository.addNpcEvent(campaignId, 'Mercante', sessionId, 'Aiuta', 'INTERACTION', false, undefined, 4, 0);
        npcRepository.addNpcEvent(campaignId, 'Mercante', sessionId, 'Protegge', 'INTERACTION', false, undefined, 4, 0);
        npcRepository.addNpcEvent(campaignId, 'Mercante', sessionId, 'Mente', 'BETRAYAL', false, undefined, -4, 0);
        // avg = (4+4+4-4)/4 = 2.0, *10 = 20 → NEUTRAL
        const before = npcScore('Mercante');
        expect(before.moral_score).toBe(20);
        expect(before.alignment_moral).toBe('NEUTRAL');

        // Force scores to garbage values to verify rebuild fixes them
        db.prepare('UPDATE npc_dossier SET moral_score = 999 WHERE campaign_id = ? AND lower(name) = lower(?)').run(campaignId, 'mercante');

        await rebuildAlignment.rebuildNpcs(campaignId, []);

        const after = npcScore('Mercante');
        expect(after.moral_score).toBe(20);
        expect(after.alignment_moral).toBe('NEUTRAL');
    });
});
