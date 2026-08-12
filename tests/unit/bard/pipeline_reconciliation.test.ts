
import { generateSummary } from '../../../src/bard/summary';
import {
    getSessionTranscript,
    getSessionNotes,
    getCampaignById,
    getCampaignSnapshot,
    getSessionCampaignId,
    getUserProfile,
    npcRepository,
    questRepository,
    locationRepository,
    factionRepository,
} from '../../../src/db';
import { getMetadataClient, getSummaryClient, getAnalystClient } from '../../../src/bard/config';
import { batchReconcile, buildEntityIndex } from '../../../src/bard/reconciliation';

// Mock DB
jest.mock('../../../src/db', () => ({
    getSessionTranscript: jest.fn(),
    getSessionNotes: jest.fn(),
    getSessionStartTime: jest.fn().mockReturnValue(0),
    getSessionCampaignId: jest.fn(),
    getCampaignById: jest.fn(),
    getCampaignSnapshot: jest.fn(),
    getUserProfile: jest.fn(),
    getAllNpcs: jest.fn().mockReturnValue([]),
    listAtlasEntries: jest.fn().mockReturnValue([]),
    getCampaignCharacters: jest.fn().mockReturnValue([]),
    getNpcEntry: jest.fn(),
    updateNpcEntry: jest.fn(),
    getCharacterHistory: jest.fn().mockReturnValue([]),
    getNpcHistory: jest.fn().mockReturnValue([]),
    addSessionLog: jest.fn(),
    getSessionLog: jest.fn().mockReturnValue([]),
    npcRepository: {
        getAllNpcs: jest.fn().mockReturnValue([]),
        getSessionEncounteredNPCs: jest.fn().mockReturnValue([]),
        getNpcByShortId: jest.fn(),
    },
    locationRepository: {
        listAllAtlasEntries: jest.fn().mockReturnValue([]),
        getSessionTravelLog: jest.fn().mockReturnValue([]),
        getAtlasEntryFull: jest.fn().mockReturnValue(null),
    },
    questRepository: {
        getOpenQuests: jest.fn().mockReturnValue([]),
        getSessionQuests: jest.fn().mockReturnValue([]),
    },
    inventoryRepository: {
        getSessionInventory: jest.fn().mockReturnValue([]),
    },
    bestiaryRepository: {
        getSessionMonsters: jest.fn().mockReturnValue([]),
    },
    worldRepository: {
        getWorldEvents: jest.fn().mockReturnValue([]),
        getSessionWorldEvents: jest.fn().mockReturnValue([]),
    },
    getSessionAIOutput: jest.fn().mockReturnValue(null),
    saveSessionAIOutput: jest.fn(),
    factionRepository: {
        getPartyFaction: jest.fn().mockReturnValue(null),
        getEntityFactions: jest.fn().mockReturnValue([]),
        countFactionMembers: jest.fn().mockReturnValue({ npcs: 0, locations: 0, pcs: 0 }),
        getFactionReputation: jest.fn().mockReturnValue(null),
        findFactionByName: jest.fn().mockReturnValue(null),
    },
}));

// Mock Bard Config (AI Clients)
jest.mock('../../../src/bard/config', () => ({
    SUMMARY_MODEL: 'gpt-5-mini',
    SUMMARY_PROVIDER: 'openai',
    SUMMARY_CONTEXT_LIMIT: 128000,
    ANALYST_CONTEXT_LIMIT: 128000,
    ANALYST_OUTPUT_LIMIT: 16384,
    METADATA_MODEL: 'gpt-5-mini',
    METADATA_PROVIDER: 'openai',
    getMetadataClient: jest.fn(),
    getSummaryClient: jest.fn(),
    getAnalystClient: jest.fn(),
}));

// This test fakes the entire DB layer: scope resolution, which
// queries `campaigns` to find out which table pays, has no database to
// query. What matters here is reconciliation, not who signs the cheque.
jest.mock('../../../src/bard/ai/resolver', () => ({
    ...jest.requireActual('../../../src/bard/ai/resolver'),
    isAgenticSummaryEnabled: () => false,
}));

jest.mock('../../../src/bard/ai/scope', () => ({
    scopeForCampaign: (campaignId: number) => ({ guildId: 'test-guild', campaignId }),
    scopeForSession: () => ({ guildId: 'test-guild' }),
    runWithSessionScope: (_id: string, fn: () => unknown) => fn(),
    clearScopeCache: () => {},
}));

// Mock Reconciliation
jest.mock('../../../src/bard/reconciliation', () => ({
    buildEntityIndex: jest.fn().mockReturnValue({}),
    batchReconcile: jest.fn().mockResolvedValue([]),
}));

// Mock other bard modules
jest.mock('../../../src/bard/rag', () => ({
    searchKnowledge: jest.fn().mockResolvedValue([]),
    ingestSessionComplete: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../src/bard/manifesto', () => ({
    getOrCreateManifesto: jest.fn().mockResolvedValue(''),
}));
jest.mock('../../../src/bard/bio', () => ({
    generateBio: jest.fn().mockResolvedValue(''),
}));
jest.mock('../../../src/monitor', () => ({
    monitor: { logAIRequestWithCost: jest.fn() }
}));

describe('End-to-End Pipeline Reconciliation (Siri/Ciri)', () => {
    const CAMPAIGN_ID = 1;
    const SESSION_ID = 'session-123';

    let mockMetadataCreate: jest.Mock;
    let mockSummaryCreate: jest.Mock;
    let mockAnalystCreate: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();

        mockMetadataCreate = jest.fn();
        mockSummaryCreate = jest.fn();
        mockAnalystCreate = jest.fn();

        (getMetadataClient as jest.Mock).mockResolvedValue({
            client: { chat: { completions: { create: mockMetadataCreate } } },
            model: 'gpt-5-mini',
            provider: 'openai'
        });
        (getSummaryClient as jest.Mock).mockResolvedValue({
            client: { chat: { completions: { create: mockSummaryCreate } } },
            model: 'gpt-5-mini',
            provider: 'openai'
        });
        (getAnalystClient as jest.Mock).mockResolvedValue({
            client: { chat: { completions: { create: mockAnalystCreate } } },
            model: 'gpt-5-mini',
            provider: 'openai'
        });

        // Default Mock Returns
        (getSessionCampaignId as jest.Mock).mockReturnValue(CAMPAIGN_ID);
        (getSessionTranscript as jest.Mock).mockReturnValue([
            { transcription_text: 'Siri appare nel pensiero profondo.', character_name: 'Narratore', user_id: 'user1', timestamp: Date.now() }
        ]);
        (getUserProfile as jest.Mock).mockReturnValue({ character_name: 'Test Character' });
        (getSessionNotes as jest.Mock).mockReturnValue([]);
        (getCampaignById as jest.Mock).mockReturnValue({ id: CAMPAIGN_ID, name: 'Test Campaign' });
        (getCampaignSnapshot as jest.Mock).mockReturnValue({ location_context: 'Test Location' });

        // Database has CIRI (Canonical)
        (npcRepository.getAllNpcs as jest.Mock).mockReturnValue([
            { id: 100, name: 'Ciri', description: 'Bambina dai capelli argentei, voce di Ogma.', status: 'ALIVE', role: 'Prescelta' }
        ]);

        // Mock quest and location repositories
        (questRepository.getOpenQuests as jest.Mock).mockReturnValue([]);
        (locationRepository.listAllAtlasEntries as jest.Mock).mockReturnValue([]);
    });

    it('should identify Siri in text and hydrate with Ciri data for the analyst', async () => {
        // 1. Mock Scout: identifies "Siri"
        mockMetadataCreate.mockImplementation(async (args) => {
            // Concatenates system+user: the llm/generate dispatcher always sends both.
            const prompt = args.messages.map((m: any) => m.content).join('\n');
            if (prompt.includes('npcs')) {
                return {
                    choices: [{ message: { content: JSON.stringify({ npcs: ['Siri'], locations: [], quests: [] }) } }],
                    usage: { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5 }
                };
            }
            return { choices: [{ message: { content: '{}' } }], usage: { total_tokens: 5, prompt_tokens: 3, completion_tokens: 2 } };
        });

        // 2. Mock batchReconcile: Siri -> matched to Ciri
        (batchReconcile as jest.Mock).mockResolvedValue([
            {
                originalName: 'Siri',
                type: 'npc',
                matched: true,
                matchedEntity: { name: 'Ciri', shortId: 'ciri-01' },
                isNew: false,
                isPlayerCharacter: false,
                confidence: 0.9,
                reason: 'phonetic similarity'
            }
        ]);

        // 3. Mock npcRepository.getNpcByShortId to return Ciri
        (npcRepository.getNpcByShortId as jest.Mock).mockReturnValue({
            id: 100,
            name: 'Ciri',
            short_id: 'ciri-01',
            description: 'Bambina dai capelli argentei, voce di Ogma.',
            status: 'ALIVE',
            role: 'Prescelta'
        });

        // 4. Mock Analyst (uses getAnalystClient, messages[1] is the user prompt)
        let analystPrompt = '';
        mockAnalystCreate.mockImplementation(async (args) => {
            analystPrompt = args.messages[1].content;
            return {
                choices: [{ message: { content: JSON.stringify({ log: ['Incontro con Siri'] }) } }],
                usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
            };
        });

        // 5. Mock Writer (uses getSummaryClient)
        mockSummaryCreate.mockResolvedValue({
            choices: [{ message: { content: JSON.stringify({ summary: 'Narrazione de prova', title: 'Titolo' }) } }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        });

        await generateSummary(SESSION_ID, 'DM', undefined, { forceRegeneration: true });

        // Verify batchReconcile was called with entities including 'Siri'
        expect(batchReconcile).toHaveBeenCalled();
        const batchArgs = (batchReconcile as jest.Mock).mock.calls[0];
        const entities = batchArgs[1] as Array<{ name: string; type: string }>;
        expect(entities.some(e => e.name === 'Siri' && e.type === 'npc')).toBe(true);

        // Analyst prompt must contain Ciri's historical data
        expect(analystPrompt).toContain('NPCS PRESENT (Historical Data)');
        expect(analystPrompt).toContain('Ciri');
        expect(analystPrompt).toContain('Bambina dai capelli argentei, voce di Ogma');
        expect(analystPrompt).toContain('- **Ciri**');
    });
});
