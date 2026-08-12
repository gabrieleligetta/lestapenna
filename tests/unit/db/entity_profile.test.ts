/**
 * The appearance dossier as a record: what it keeps, who owns which field, and
 * how it admits it has fallen behind the campaign.
 *
 * Ownership is the part worth testing hard. It is per field, not per record,
 * because the person most likely to correct one line is the one with the most
 * to add — and freezing their whole dossier for it would punish exactly the
 * behaviour this feature wants.
 */
import { createCampaign, deleteCampaign } from '../../../src/db';
import {
    entityProfileRepository,
    parseAppearance,
    parseEvidence,
    parseManualFields,
    parsePersonality,
} from '../../../src/db/repositories/EntityProfileRepository';
import type { PersonAppearance } from '../../../src/db/types';

describe('entity profile repository', () => {
    let campaignId: number;

    beforeAll(() => {
        campaignId = createCampaign('Test Entity Profile', 'test-guild');
    });

    afterAll(() => {
        try { deleteCampaign(campaignId); } catch { /* the campaign may already be gone */ }
    });

    const appearance: PersonAppearance = {
        age_band: 'young adult',
        hair: { colour: 'white', length: 'short', style: 'swept back' },
        armour: { type: 'plate cuirass', material: 'steel', finish: 'polished' },
    };

    /** An analysis: no owned fields, evidence attached. */
    const analysed = (key: string, traits: PersonAppearance, evidence = [
        { trait: 'hair.colour', quote: 'ha i capelli bianchi', source: 'transcript' as const, session_id: '12' },
    ]) => entityProfileRepository.upsert({
        campaign_id: campaignId,
        entity_type: 'npc',
        entity_key: key,
        appearance: traits,
        personality: { temperament: 'cold' },
        evidence,
        confidence: 'HIGH',
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
        isManual: false,
    });

    /** A person filling fields in by hand. */
    const written = (key: string, fields: Record<string, unknown>) => entityProfileRepository.upsert({
        campaign_id: campaignId,
        entity_type: 'npc',
        entity_key: key,
        appearance: unflatten(fields, false) as never,
        personality: unflatten(fields, true) as never,
        evidence: [],
        confidence: null,
        provider: null,
        model: null,
        isManual: true,
        manualFields: Object.keys(fields),
    });

    test('stores traits, evidence and confidence, and reads them back', () => {
        const { saved } = analysed('astr1', appearance);

        expect(saved?.confidence).toBe('HIGH');
        expect(saved?.is_manual).toBe(0);
        expect(parseAppearance(saved)).toEqual(appearance);
        expect(parseEvidence(saved)).toHaveLength(1);
        expect(parsePersonality(saved).fields).toEqual({ temperament: 'cold' });
        // Rendered from the fields, not asked of a model.
        expect(saved?.appearance_text).toContain('colour white');
    });

    test('a hand-written field lands next to what the analysis found', () => {
        written('astr1', { eyes: 'amber', 'personality.voice': 'low and level' });

        const saved = entityProfileRepository.getForEntity(campaignId, 'npc', 'astr1');
        expect(parseAppearance(saved)).toMatchObject({
            eyes: 'amber',
            hair: { colour: 'white' },
        });
        expect(parsePersonality(saved).fields).toMatchObject({ temperament: 'cold', voice: 'low and level' });
        expect(parseManualFields(saved).sort()).toEqual(['eyes', 'personality.voice']);
        expect(saved?.is_manual).toBe(1);
    });

    test('a later analysis fills what nobody owns and steps around what somebody does', () => {
        const { saved, keptFields } = analysed('astr1', {
            ...appearance,
            eyes: 'a deep green',
            bearing: 'stiff',
        });

        expect(keptFields.sort()).toEqual(['eyes', 'personality.voice']);
        // The owner's value survives; everything they did not touch is refreshed.
        expect(parseAppearance(saved)).toMatchObject({ eyes: 'amber', bearing: 'stiff' });
        expect(parsePersonality(saved).fields).toMatchObject({ voice: 'low and level' });
    });

    test('clearing a field releases it back to the AI', () => {
        written('astr1', { eyes: null });

        const released = entityProfileRepository.getForEntity(campaignId, 'npc', 'astr1');
        expect(parseManualFields(released)).toEqual(['personality.voice']);
        expect((parseAppearance(released) as any)?.eyes).toBeUndefined();

        const { saved, keptFields } = analysed('astr1', { ...appearance, eyes: 'a deep green' });
        expect(keptFields).toEqual(['personality.voice']);
        expect(parseAppearance(saved)).toMatchObject({ eyes: 'a deep green' });
    });

    test('a quote no longer supports a value a person replaced', () => {
        written('astr1', { 'hair.colour': 'silver' });

        const saved = entityProfileRepository.getForEntity(campaignId, 'npc', 'astr1');
        expect(parseAppearance(saved)).toMatchObject({ hair: { colour: 'silver' } });
        expect(parseEvidence(saved).map(item => item.trait)).not.toContain('hair.colour');
    });

    test('a dossier can be written entirely by hand, with no analysis ever run', () => {
        const { saved } = written('byhand', {
            'hair.colour': 'black',
            weapons: ['a bone-handled knife'],
        });

        expect(parseAppearance(saved)).toEqual({
            hair: { colour: 'black' },
            weapons: ['a bone-handled knife'],
        });
        expect(saved?.provider).toBeNull();
        expect(saved?.appearance_text).toContain('a bone-handled knife');
    });

    test('a later session marks the dossier stale exactly once, and a new write clears it', () => {
        expect(entityProfileRepository.markStale(campaignId, 'session-42', [
            { entityType: 'npc', entityKey: 'byhand' },
        ])).toBe(1);
        expect(
            entityProfileRepository.getForEntity(campaignId, 'npc', 'byhand')?.stale_since_session_id,
        ).toBe('session-42');

        // The flag names the first session that moved past the dossier, so a
        // second one does not overwrite it with a later, less useful id.
        expect(entityProfileRepository.markStale(campaignId, 'session-43', [
            { entityType: 'npc', entityKey: 'byhand' },
        ])).toBe(0);

        written('byhand', { eyes: 'grey' });
        expect(
            entityProfileRepository.getForEntity(campaignId, 'npc', 'byhand')?.stale_since_session_id,
        ).toBeNull();
    });

    test('unreadable stored JSON degrades to nothing recorded instead of throwing', () => {
        const entry = entityProfileRepository.getForEntity(campaignId, 'npc', 'astr1')!;
        const corrupted = { ...entry, appearance_json: '{not json', evidence_json: '[', manual_fields: 'x' };

        expect(parseAppearance(corrupted)).toBeNull();
        expect(parseEvidence(corrupted)).toEqual([]);
        expect(parseManualFields(corrupted)).toEqual([]);
    });
});

/** `{ 'hair.colour': 'white' }` → `{ hair: { colour: 'white' } }`, one half at a time. */
function unflatten(fields: Record<string, unknown>, personality: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(fields)) {
        const isPersonality = path.startsWith('personality.');
        if (isPersonality !== personality) continue;
        const key = isPersonality ? path.slice('personality.'.length) : path;
        const [head, tail] = key.split('.');
        if (!tail) out[head] = value;
        else out[head] = { ...(out[head] as object ?? {}), [tail]: value };
    }
    return out;
}
