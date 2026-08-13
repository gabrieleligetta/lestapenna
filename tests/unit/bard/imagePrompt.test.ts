/**
 * Where the words for a portrait come from.
 *
 * The three modes differ in exactly one thing — the material — and the tests are
 * mostly about what each one is allowed to spend. `prompt` must not call a text
 * model at all: someone who wrote what they want has done the work, and billing
 * them to be paraphrased would be charging for nothing.
 */

const mockGenerateText: any = jest.fn();
jest.mock('../../../src/bard/llm/generate', () => ({
    generateText: (...args: unknown[]) => mockGenerateText(...args),
}));

const mockGetMetadataClient: any = jest.fn();
jest.mock('../../../src/bard/config', () => ({
    getMetadataClient: (...args: unknown[]) => mockGetMetadataClient(...args),
}));

const mockSearchKnowledge: any = jest.fn();
jest.mock('../../../src/bard/rag/search', () => ({
    searchKnowledge: (...args: unknown[]) => mockSearchKnowledge(...args),
}));

const mockGetNpc: any = jest.fn();
jest.mock('../../../src/db/repositories/NpcRepository', () => ({
    npcRepository: { getNpcByShortId: (...a: unknown[]) => mockGetNpc(...a) },
}));

const mockGetLocation: any = jest.fn();
jest.mock('../../../src/db/repositories/LocationRepository', () => ({
    locationRepository: { getAtlasEntryByShortId: (...a: unknown[]) => mockGetLocation(...a) },
}));

jest.mock('../../../src/db/repositories/ArtifactRepository', () => ({
    artifactRepository: { getArtifactByShortId: () => null },
}));

jest.mock('../../../src/db/repositories/CharacterRepository', () => ({
    characterRepository: {
        getUserProfile: () => ({ character_name: null }),
        getCharacterRowId: () => null,
    },
}));

jest.mock('../../../src/db/repositories/FactionRepository', () => ({
    factionRepository: { getEntityFactions: () => [] },
}));

const mockGetCampaign: any = jest.fn();
jest.mock('../../../src/db/repositories/CampaignRepository', () => ({
    campaignRepository: { getCampaignById: (...args: unknown[]) => mockGetCampaign(...args) },
}));

const mockGetProfile: any = jest.fn();
jest.mock('../../../src/db/repositories/EntityProfileRepository', () => {
    const actual = jest.requireActual('../../../src/db/repositories/EntityProfileRepository');
    return {
        // The parsers are pure and are part of what these tests exercise: a
        // stubbed parser would leave the assembly untested.
        parseAppearance: actual.parseAppearance,
        parsePersonality: actual.parsePersonality,
        entityProfileRepository: { getForEntity: (...args: unknown[]) => mockGetProfile(...args) },
    };
});

// The scope resolves the campaign's guild from the database. Nothing here is
// testing that lookup, and a real one would need a schema this suite has no use for.
jest.mock('../../../src/bard/ai/scope', () => ({
    scopeForCampaign: (campaignId: number) => ({ guildId: 'g1', campaignId }),
}));

import {
    AppearanceDossierRequiredError,
    buildPortraitPrompt,
    shapeFor,
} from '../../../src/bard/imagePrompt';

const PRINCE = {
    name: 'Principe Belgarde',
    role: 'Heir to the throne',
    status: 'ALIVE',
    description: 'A haughty young noble.',
    manual_description: null,
    aliases: 'The Pale Prince',
    last_seen_location: 'The Winter Court',
};

beforeEach(() => {
    jest.clearAllMocks();
    mockGetMetadataClient.mockResolvedValue({ model: 'gemini-3-flash-preview', provider: 'gemini' });
    mockGenerateText.mockResolvedValue({
        content: 'A pale young man in a fur-lined cloak.',
        usage: { input: 400, output: 90, cached: 0 },
    });
    mockGetNpc.mockReturnValue(PRINCE);
    mockSearchKnowledge.mockResolvedValue(['He never takes off his gloves.']);
    mockGetCampaign.mockReturnValue({ id: 1, name: 'Tavolo', art_direction: null });
    // No dossier by default: these suites cover the fallback path, and the
    // assembled one has its own below.
    mockGetProfile.mockReturnValue(null);
});

/** A dossier row as the repository returns it. */
function dossier(appearance: unknown, personality?: unknown) {
    return {
        appearance_json: JSON.stringify(appearance),
        personality_text: personality ? JSON.stringify(personality) : null,
        evidence_json: '[]',
    };
}

describe('the shape a portrait is generated in', () => {
    it('follows the slot each card actually renders', () => {
        // Generating a square for a slot displayed 4:5 crops a face in half.
        expect(shapeFor('npc')).toBe('portrait');
        expect(shapeFor('character')).toBe('portrait');
        expect(shapeFor('location')).toBe('landscape');
        expect(shapeFor('artifact')).toBe('square');
    });
});

describe('drawing from the appearance dossier', () => {
    const ASTRID = {
        age_band: 'young adult',
        hair: { colour: 'white', length: 'short', style: 'swept back' },
        eyes: 'amber',
        armour: { type: 'plate cuirass', material: 'steel', finish: 'polished' },
        garments: ['a long grey gown'],
        insignia: 'the mark of the Vergini di Ferro',
        weapons: ['longsword'],
    };

    it('puts every recorded trait in the prompt, and calls no model to do it', async () => {
        mockGetProfile.mockReturnValue(dossier(ASTRID));

        const result = await buildPortraitPrompt({
            campaignId: 1, entityType: 'npc', entityId: 'astr1', mode: 'auto',
        });

        // The failure this whole feature exists to end: a paragraph writer drops
        // "white" for rhythm, or supplies an eye colour nobody ever recorded.
        expect(result.prompt).toContain('white');
        expect(result.prompt).toContain('swept back');
        expect(result.prompt).toContain('amber');
        expect(result.prompt).toContain('plate cuirass');
        expect(result.prompt).toContain('the mark of the Vergini di Ferro');
        expect(result.prompt).toContain('longsword');

        expect(result.sources).toEqual(['dossier']);
        expect(result.usedTextCall).toBe(false);
        expect(mockGenerateText).not.toHaveBeenCalled();
        expect(mockSearchKnowledge).not.toHaveBeenCalled();
    });

    it('produces the same prompt twice, so a regeneration is not a re-roll', async () => {
        mockGetProfile.mockReturnValue(dossier(ASTRID));

        const first = await buildPortraitPrompt({
            campaignId: 1, entityType: 'npc', entityId: 'astr1', mode: 'auto',
        });
        const second = await buildPortraitPrompt({
            campaignId: 1, entityType: 'npc', entityId: 'astr1', mode: 'auto',
        });

        expect(second.prompt).toBe(first.prompt);
    });

    it('says nothing about a trait the campaign never recorded', async () => {
        mockGetProfile.mockReturnValue(dossier({ hair: { colour: 'white' } }));

        const result = await buildPortraitPrompt({
            campaignId: 1, entityType: 'npc', entityId: 'astr1', mode: 'auto',
        });

        expect(result.prompt).toContain('white');
        expect(result.prompt).not.toMatch(/Eyes:/);
        expect(result.prompt).not.toMatch(/Carrying:/);
        // And it tells the model to leave the gap plain rather than fill it,
        // which is where an unprompted tiefling comes from.
        expect(result.prompt).toMatch(/rather than inventing/i);
    });

    it('keeps the person\'s words binding on top of the record', async () => {
        mockGetProfile.mockReturnValue(dossier(ASTRID));

        const result = await buildPortraitPrompt({
            campaignId: 1,
            entityType: 'npc',
            entityId: 'astr1',
            mode: 'mixed',
            userPrompt: 'show her helmed',
        });

        expect(result.sources).toEqual(['dossier', 'user']);
        expect(result.prompt).toContain('show her helmed');
        expect(result.prompt).toContain('overrides anything above');
        expect(result.prompt.indexOf('show her helmed')).toBeGreaterThan(result.prompt.indexOf('white'));
    });

    it('shows a manner but not a whole temperament: a portrait is not a biography', async () => {
        mockGetProfile.mockReturnValue(dossier(ASTRID, {
            manner: 'stiff and formal',
            temperament: 'ruthless towards deserters',
        }));

        const result = await buildPortraitPrompt({
            campaignId: 1, entityType: 'npc', entityId: 'astr1', mode: 'auto',
        });

        expect(result.prompt).toContain('stiff and formal');
        expect(result.prompt).not.toContain('deserters');
    });

    it('refuses an empty dossier instead of silently replacing identity with a sheet summary', async () => {
        mockGetProfile.mockReturnValue(dossier({}));

        await expect(buildPortraitPrompt({
            campaignId: 1, entityType: 'npc', entityId: 'astr1', mode: 'auto',
        })).rejects.toBeInstanceOf(AppearanceDossierRequiredError);
        expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it('assembles a place and an object from their own vocabulary', async () => {
        mockGetProfile.mockReturnValue(dossier({
            architecture: 'squat granite towers',
            light: 'overcast',
            notable_features: ['a frozen fountain'],
        }));

        const place = await buildPortraitPrompt({
            campaignId: 1, entityType: 'location', entityId: 'cwxpj', mode: 'auto',
        });

        expect(place.prompt).toContain('squat granite towers');
        expect(place.prompt).toContain('a frozen fountain');
        expect(place.prompt).toContain('wide shot');
    });
});

describe('the campaign\'s own art direction', () => {
    it('replaces the built-in style when the table has written one', async () => {
        mockGetCampaign.mockReturnValue({
            id: 1,
            art_direction: 'Grim charcoal sketches, heavy hatching, no colour.',
        });
        mockGetProfile.mockReturnValue(dossier({ hair: { colour: 'white' } }));

        const result = await buildPortraitPrompt({
            campaignId: 1, entityType: 'npc', entityId: 'astr1', mode: 'auto',
        });

        expect(result.prompt).toContain('Grim charcoal sketches');
        expect(result.prompt).not.toContain('painterly digital illustration');
    });

    it('treats a cleared field as no preference, not as an empty instruction', async () => {
        mockGetCampaign.mockReturnValue({ id: 1, art_direction: '   ' });

        const result = await buildPortraitPrompt({
            campaignId: 1, entityType: 'npc', entityId: 'astr1', mode: 'prompt', userPrompt: 'a knight',
        });

        expect(result.prompt).toContain('painterly digital illustration');
    });
});

describe('mode: prompt', () => {
    it('uses the person\'s words and spends nothing on rewording them', async () => {
        const result = await buildPortraitPrompt({
            campaignId: 1,
            entityType: 'npc',
            entityId: 'wkgkd',
            mode: 'prompt',
            userPrompt: 'an old woman with a raven on her shoulder',
        });

        expect(result.prompt).toContain('an old woman with a raven on her shoulder');
        expect(result.sources).toEqual(['user']);
        expect(result.usedTextCall).toBe(false);
        expect(result.textUsage).toBeNull();
        expect(mockGenerateText).not.toHaveBeenCalled();
        // Nor does it read the campaign, which would be work for nothing.
        expect(mockSearchKnowledge).not.toHaveBeenCalled();
    });

    it('refuses when there is nothing to work from', async () => {
        await expect(buildPortraitPrompt({
            campaignId: 1,
            entityType: 'npc',
            entityId: 'wkgkd',
            mode: 'prompt',
            userPrompt: '   ',
        })).rejects.toThrow();
    });
});

describe('mode: auto', () => {
    it('requires an appearance dossier before any provider is called', async () => {
        await expect(buildPortraitPrompt({
            campaignId: 1,
            entityType: 'npc',
            entityId: 'wkgkd',
            mode: 'auto',
        })).rejects.toBeInstanceOf(AppearanceDossierRequiredError);
        expect(mockGenerateText).not.toHaveBeenCalled();
        expect(mockSearchKnowledge).not.toHaveBeenCalled();
    });

    it('assembles a dossier locally without a text-model charge', async () => {
        mockGetProfile.mockReturnValue(dossier({
            hair: { colour: 'white' },
            eyes: 'amber',
        }));
        const result = await buildPortraitPrompt({
            campaignId: 1, entityType: 'npc', entityId: 'wkgkd', mode: 'auto',
        });

        expect(result.sources).toEqual(['dossier']);
        expect(result.prompt).toContain('white');
        expect(result.textUsage).toBeNull();
        expect(mockGetMetadataClient).not.toHaveBeenCalled();
        expect(mockGenerateText).not.toHaveBeenCalled();
    });
});

describe('mode: mixed', () => {
    it('states the person\'s words as binding over the material', async () => {
        mockGetProfile.mockReturnValue(dossier({ hair: { colour: 'white' } }));
        const result = await buildPortraitPrompt({
            campaignId: 1,
            entityType: 'npc',
            entityId: 'wkgkd',
            mode: 'mixed',
            userPrompt: 'make him much older',
        });

        expect(result.sources).toEqual(['dossier', 'user']);
        expect(result.prompt).toContain('make him much older');
        expect(result.prompt).toContain('overrides anything above');
        // Last, so the instruction it carries is the one still in view.
        expect(result.prompt.indexOf('make him much older')).toBeGreaterThan(
            result.prompt.indexOf('white'),
        );
    });
});

describe('the house style', () => {
    it('frames a place differently from a face', async () => {
        mockGetLocation.mockReturnValue({
            micro_location: 'Moonlit Library',
            macro_location: 'Winterhold',
            description: 'Shelves to the ceiling.',
            manual_description: null,
        });

        mockGetProfile.mockReturnValueOnce(dossier({ architecture: 'tower', light: 'moonlit' }));
        const place = await buildPortraitPrompt({
            campaignId: 1, entityType: 'location', entityId: 'cwxpj', mode: 'auto',
        });
        mockGetProfile.mockReturnValueOnce(dossier({ hair: { colour: 'white' } }));
        const face = await buildPortraitPrompt({
            campaignId: 1, entityType: 'npc', entityId: 'wkgkd', mode: 'auto',
        });

        expect(place.prompt).toContain('wide shot');
        expect(face.prompt).toContain('head and shoulders');
    });

    it('tells the model not to write on the picture, in every mode', async () => {
        // Image models like to letter things, and a portrait captioned in
        // invented runes is worse than one with no caption.
        const written = await buildPortraitPrompt({
            campaignId: 1, entityType: 'npc', entityId: 'wkgkd', mode: 'prompt', userPrompt: 'a knight',
        });
        mockGetProfile.mockReturnValue(dossier({ hair: { colour: 'white' } }));
        const derived = await buildPortraitPrompt({
            campaignId: 1, entityType: 'npc', entityId: 'wkgkd', mode: 'auto',
        });

        expect(written.prompt).toContain('Do not render any text');
        expect(derived.prompt).toContain('Do not render any text');
    });
});
