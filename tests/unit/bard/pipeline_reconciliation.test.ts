
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
    locationRepository
} from '../../../src/db';
import { metadataClient, summaryClient } from '../../../src/bard/config';
import { reconcileNpcName } from '../../../src/bard/reconciliation/npc';
import { reconcileLocationName } from '../../../src/bard/reconciliation/location';

// Mock DB
jest.mock('../../../src/db', () => ({
    getSessionTranscript: jest.fn(),
    getSessionNotes: jest.fn(),
    getSessionStartTime: jest.fn(),
    getSessionCampaignId: jest.fn(),
    getCampaignById: jest.fn(),
    getCampaignSnapshot: jest.fn(),
    getUserProfile: jest.fn(),
    npcRepository: {
        getAllNpcs: jest.fn(),
        getSessionEncounteredNPCs: jest.fn(),
    },
    locationRepository: {
        listAllAtlasEntries: jest.fn(),
        getSessionTravelLog: jest.fn(),
    },
    questRepository: {
        getOpenQuests: jest.fn(),
        getSessionQuests: jest.fn(),
    },
    inventoryRepository: {
        getSessionInventory: jest.fn(),
    },
    bestiaryRepository: {
        getSessionMonsters: jest.fn(),
    },
    getSessionAIOutput: jest.fn(),
    saveSessionAIOutput: jest.fn(),
}));

// Mock Bard Config (AI Clients)
jest.mock('../../../src/bard/config', () => ({
    SUMMARY_MODEL: 'gpt-5-mini',
    SUMMARY_PROVIDER: 'openai',
    METADATA_MODEL: 'gpt-5-mini',
    METADATA_PROVIDER: 'openai',
    metadataClient: {
        chat: {
            completions: {
                create: jest.fn(),
            },
        },
    },
    summaryClient: {
        chat: {
            completions: {
                create: jest.fn(),
            },
        },
    },
}));

// Mock Reconciliation Modules
jest.mock('../../../src/bard/reconciliation/npc', () => ({
    reconcileNpcName: jest.fn(),
}));
jest.mock('../../../src/bard/reconciliation/location', () => ({
    reconcileLocationName: jest.fn(),
}));

describe('End-to-End Pipeline Reconciliation (Siri/Ciri)', () => {
    const CAMPAIGN_ID = 1;
    const SESSION_ID = 'session-123';

    beforeEach(() => {
        jest.clearAllMocks();

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
        (metadataClient.chat.completions.create as jest.Mock).mockImplementation(async (args) => {
            const prompt = args.messages[0].content;
            if (prompt.includes('npcs')) {
                return {
                    choices: [{ message: { content: JSON.stringify({ npcs: ['Siri'], locations: [], quests: [] }) } }],
                    usage: { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5 }
                };
            }
            return { choices: [{ message: { content: '{}' } }], usage: {} };
        });

        // 2. Mock NPC Reconciliation: Siri -> Ciri
        (reconcileNpcName as jest.Mock).mockResolvedValue({
            canonicalName: 'Ciri',
            existingNpc: { name: 'Ciri', description: 'Bambina dai capelli argentei, voce di Ogma.', status: 'ALIVE', role: 'Prescelta' }
        });

        // 3. Mock Location Reconciliation: return null
        (reconcileLocationName as jest.Mock).mockResolvedValue(null);

        // 4. Mock Analyst and Writer
        let analystPrompt = '';
        (summaryClient.chat.completions.create as jest.Mock).mockImplementation(async (args) => {
            const prompt = args.messages[1].content;

            if (prompt.includes('Sei un ANALISTA DATI')) {
                analystPrompt = prompt;
                return {
                    choices: [{ message: { content: JSON.stringify({ log: ['Incontro con Siri'] }) } }],
                    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
                };
            }

            return {
                choices: [{ message: { content: JSON.stringify({ summary: 'Narrazione de prova', title: 'Titolo' }) } }],
                usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
            };
        });

        await generateSummary(SESSION_ID, 'DM', undefined, { forceRegeneration: true });

        // VERIFICATIONS

        // Verify Reconcile was called for Siri
        expect(reconcileNpcName).toHaveBeenCalledWith(CAMPAIGN_ID, 'Siri');

        // Analyst prompt must contain Ciri's historical data
        expect(analystPrompt).toContain('NPC PRESENTI (Dati Storici)');
        expect(analystPrompt).toContain('Ciri');
        expect(analystPrompt).toContain('Bambina dai capelli argentei, voce di Ogma');
        expect(analystPrompt).toContain('- **Ciri**');
    });
});
