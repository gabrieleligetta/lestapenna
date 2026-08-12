/**
 * The appearance analysis, at the two seams that decide whether a dossier is
 * true: what material the run is given, and what it is allowed to keep.
 *
 * The second one carries the weight. Every guard here is a case that already
 * happened in production in another form — a model asked to describe an NPC
 * whose records hold no physical detail returned a tiefling with ram horns, a
 * scar and gold eyes, none of it written anywhere. The normalizer is where that
 * answer stops being storable.
 */

const mockGetNpc: any = jest.fn();
jest.mock('../../../src/db/repositories/NpcRepository', () => ({
    npcRepository: { getNpcByShortId: (...args: unknown[]) => mockGetNpc(...args) },
}));

const mockGetEntityFactions: any = jest.fn();
const mockGetFaction: any = jest.fn();
const mockFindFactionByName: any = jest.fn();
jest.mock('../../../src/db/repositories/FactionRepository', () => ({
    factionRepository: {
        getEntityFactions: (...args: unknown[]) => mockGetEntityFactions(...args),
        getFaction: (...args: unknown[]) => mockGetFaction(...args),
        findFactionByName: (...args: unknown[]) => mockFindFactionByName(...args),
    },
}));

jest.mock('../../../src/db/repositories/LocationRepository', () => ({
    locationRepository: { getAtlasEntryByShortId: () => null },
}));
jest.mock('../../../src/db/repositories/ArtifactRepository', () => ({
    artifactRepository: { getArtifactByShortId: () => null },
}));
jest.mock('../../../src/db/repositories/CharacterRepository', () => ({
    characterRepository: { getUserProfile: () => ({ character_name: null }), getCharacterRowId: () => null },
}));

// The tools reach the whole database; this suite is about the prompt and the
// normalizer, and a real tool set would drag the schema in behind it.
jest.mock('../../../src/bard/agent/tools', () => ({
    createBardoTools: () => [],
    createAppearanceTools: () => [],
}));

import {
    APPEARANCE_FIELDS,
    normalizeAppearanceOutput,
    prepareAppearanceAnalysis,
    renderAppearanceText,
    SubjectNotFoundError,
} from '../../../src/bard/agent/entityAppearance';

const ASTRID = {
    id: 7,
    name: 'Astrid Foe',
    role: 'Capo delle Guardie',
    status: 'ALIVE',
    description: 'Comandante delle Vergini di Ferro, mercenaria inflessibile.',
    manual_description: null,
    aliases: 'Signorina Faux',
    last_seen_location: 'Fortezza',
};

beforeEach(() => {
    jest.clearAllMocks();
    mockGetNpc.mockReturnValue(ASTRID);
    mockGetEntityFactions.mockReturnValue([{ faction_name: 'Vergini di Ferro', role: 'LEADER' }]);
});

describe('preparing the analysis', () => {
    test('offers the faction the subject belongs to, which is where the livery is described', () => {
        const prepared = prepareAppearanceAnalysis({ campaignId: 1, entityType: 'npc', entityId: '8j4u4' });

        expect(prepared.subject.name).toBe('Astrid Foe');
        expect(prepared.userPrompt).toContain('Vergini di Ferro');
        expect(prepared.userPrompt).toContain('get_faction_profile');
    });

    test('sends the run to the transcripts, the only place a spoken detail survives', () => {
        const prepared = prepareAppearanceAnalysis({ campaignId: 1, entityType: 'npc', entityId: '8j4u4' });

        expect(prepared.userPrompt).toContain('search_transcripts');
    });

    test('states that an empty answer is a valid one', () => {
        const prepared = prepareAppearanceAnalysis({ campaignId: 1, entityType: 'npc', entityId: '8j4u4' });

        expect(prepared.userPrompt).toMatch(/empty result is a valid/i);
        expect(prepared.userPrompt).toMatch(/not_recorded/);
    });

    test('offers only the vocabulary that fits the kind of subject', () => {
        const prepared = prepareAppearanceAnalysis({ campaignId: 1, entityType: 'npc', entityId: '8j4u4' });

        for (const field of APPEARANCE_FIELDS.person) expect(prepared.userPrompt).toContain(field);
        // A person has no architecture, and offering the word invites a sentence
        // about one.
        expect(prepared.userPrompt).not.toContain('architecture');
    });

    test('an unknown subject is a fact about the request, not a server failure', () => {
        mockGetNpc.mockReturnValue(null);

        expect(() => prepareAppearanceAnalysis({ campaignId: 1, entityType: 'npc', entityId: 'nope1' }))
            .toThrow(SubjectNotFoundError);
    });
});

describe('normalizing what came back', () => {
    const evidenced = (field: string, value: string, confidence = 'HIGH') => ({
        field,
        value,
        evidence: `qualcuno ha detto "${value}"`,
        source: 'transcript',
        session: '12',
        confidence,
    });

    test('keeps an evidenced trait and files it under its nested field', () => {
        const result = normalizeAppearanceOutput('person', {
            traits: [evidenced('hair.colour', 'white'), evidenced('age_band', 'young adult')],
            personality: [],
            not_recorded: [],
        });

        expect(result.appearance).toEqual({ hair: { colour: 'white' }, age_band: 'young adult' });
        expect(result.evidence).toHaveLength(2);
    });

    test('drops a trait with no evidence — the exact shape of the invented portrait', () => {
        const result = normalizeAppearanceOutput('person', {
            traits: [
                { field: 'hair.colour', value: 'raven black', source: 'rag', confidence: 'HIGH' },
                { field: 'eyes', value: 'solid gold', evidence: '   ', source: 'rag', confidence: 'HIGH' },
                evidenced('hair.colour', 'white'),
            ],
            personality: [],
            not_recorded: [],
        });

        expect(result.appearance).toEqual({ hair: { colour: 'white' } });
        expect(result.evidence.map(entry => entry.trait)).toEqual(['hair.colour']);
    });

    test('drops a field outside the vocabulary, however confidently it was asserted', () => {
        const result = normalizeAppearanceOutput('person', {
            traits: [evidenced('horns', 'curving back like a ram'), evidenced('species', 'tiefling')],
            personality: [],
            not_recorded: [],
        });

        expect(result.appearance).toBeNull();
        expect(result.evidence).toEqual([]);
    });

    test('a subject the records never described yields nothing at all', () => {
        const result = normalizeAppearanceOutput('person', {
            traits: [],
            personality: [],
            not_recorded: ['hair.colour', 'eyes', 'height'],
        });

        expect(result.appearance).toBeNull();
        expect(result.personality).toBeNull();
        expect(result.confidence).toBeNull();
        expect(result.notRecorded).toEqual(['hair.colour', 'eyes', 'height']);
    });

    test('gathers repeatable fields instead of overwriting them', () => {
        const result = normalizeAppearanceOutput('person', {
            traits: [
                evidenced('weapons', 'longsword'),
                evidenced('weapons', 'parrying dagger'),
                evidenced('weapons', 'longsword'),
            ],
            personality: [],
            not_recorded: [],
        });

        expect(result.appearance).toEqual({ weapons: ['longsword', 'parrying dagger'] });
    });

    test('the dossier is only as strong as its weakest claim', () => {
        const result = normalizeAppearanceOutput('person', {
            traits: [
                evidenced('hair.colour', 'white', 'HIGH'),
                evidenced('armour.material', 'steel', 'MEDIUM'),
                evidenced('bearing', 'stiff', 'LOW'),
            ],
            personality: [],
            not_recorded: [],
        });

        expect(result.confidence).toBe('LOW');
    });

    test('a place keeps no temperament, whatever the model returned', () => {
        const result = normalizeAppearanceOutput('place', {
            traits: [evidenced('architecture', 'squat granite towers')],
            personality: [{ field: 'temperament', value: 'brooding', evidence: 'it felt brooding', source: 'rag', confidence: 'LOW' }],
            not_recorded: [],
        });

        expect(result.appearance).toEqual({ architecture: 'squat granite towers' });
        expect(result.personality).toBeNull();
    });

    test('a gap is only reported for a field that could have been filled', () => {
        const result = normalizeAppearanceOutput('person', {
            traits: [],
            personality: [],
            not_recorded: ['eyes', 'backstory', 'alignment'],
        });

        expect(result.notRecorded).toEqual(['eyes']);
    });

    test('junk in place of the expected shape produces an empty dossier, not a crash', () => {
        expect(normalizeAppearanceOutput('person', null).appearance).toBeNull();
        expect(normalizeAppearanceOutput('person', { traits: 'nope' }).evidence).toEqual([]);
    });
});

describe('rendering it for a reader', () => {
    test('reads back the fields without adding any', () => {
        const text = renderAppearanceText({
            age_band: 'young adult',
            hair: { colour: 'white', style: 'swept back' },
            weapons: ['longsword'],
        });

        expect(text).toContain('age band: young adult');
        expect(text).toContain('colour white');
        expect(text).toContain('weapons: longsword');
    });

    test('an empty dossier renders as nothing, not as an empty sentence', () => {
        expect(renderAppearanceText(null)).toBeNull();
        expect(renderAppearanceText({})).toBeNull();
    });
});
