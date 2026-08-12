
process.env.DISCORD_BOT_TOKEN = 'mock-token';
process.env.DISCORD_CLIENT_ID = 'mock-client-id';

import { validateBatch } from '../../../src/bard/validation';
import { getMetadataClient } from '../../../src/bard/config';

// Mock DB
jest.mock('../../../src/db', () => ({
    getNpcHistory: jest.fn(() => []),
    getCharacterHistory: jest.fn(() => []),
    getOpenQuests: jest.fn(() => []),
    npcRepository: { getNpcByShortId: jest.fn().mockReturnValue(null) },
    characterRepository: { getUserProfile: jest.fn().mockReturnValue(null) },
    artifactRepository: { getArtifactByShortId: jest.fn().mockReturnValue(null), getArtifactHistory: jest.fn().mockReturnValue([]) },
    inventoryRepository: { getInventoryItemByShortId: jest.fn().mockReturnValue(null) },
    questRepository: { getQuestByShortId: jest.fn().mockReturnValue(null) },
    locationRepository: { getAtlasEntryByShortId: jest.fn().mockReturnValue(null) },
}));

// Mock Monitor
jest.mock('../../../src/monitor', () => ({
    monitor: {
        logAIRequestWithCost: jest.fn()
    }
}));

// Mock AI Client
jest.mock('../../../src/bard/config', () => ({
    getMetadataClient: jest.fn(),
    METADATA_PROVIDER: 'openai',
    METADATA_MODEL: 'gpt-4o'
}));

describe('Bard Validation - Quest Fallbacks', () => {
    const mockInput = {
        quests: [
            { title: 'Quest A', description: 'Desc A', status: 'OPEN', type: 'MAJOR' }
        ]
    };

    let mockCreate: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockCreate = jest.fn();
        (getMetadataClient as jest.Mock).mockResolvedValue({
            client: { chat: { completions: { create: mockCreate } } },
            model: 'gpt-4o',
            provider: 'openai'
        });
    });

    it('should keep input quests if AI omits them from response', async () => {
        mockCreate.mockResolvedValue({
            choices: [{ message: { content: JSON.stringify({ npc_events: { keep: [], skip: [] } }) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 }
        });

        const result = await validateBatch(1, mockInput);

        expect(result.quests.keep).toHaveLength(1);
        expect(result.quests.keep[0].title).toBe('Quest A');
    });

    it('should handle flat array response from AI', async () => {
        mockCreate.mockResolvedValue({
            choices: [{ message: { content: JSON.stringify({ quests: ['Quest B'] }) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 }
        });

        const result = await validateBatch(1, mockInput);

        expect(result.quests.keep).toHaveLength(1);
        expect(result.quests.keep[0].title).toBe('Quest B');
    });

    it('should handle standard keep/skip response from AI', async () => {
        mockCreate.mockResolvedValue({
            choices: [{
                message: {
                    content: JSON.stringify({
                        quests: {
                            keep: [{ title: 'Quest C', description: 'Desc C', status: 'OPEN' }],
                            skip: ['Old Quest']
                        }
                    })
                }
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5 }
        });

        const result = await validateBatch(1, mockInput);

        expect(result.quests.keep).toHaveLength(1);
        expect(result.quests.keep[0].title).toBe('Quest C');
        expect(result.quests.skip).toContain('Old Quest');
    });
});
