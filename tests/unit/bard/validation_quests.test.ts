
process.env.DISCORD_BOT_TOKEN = 'mock-token';
process.env.DISCORD_CLIENT_ID = 'mock-client-id';

import { validateBatch } from '../../../src/bard/validation';
import { metadataClient } from '../../../src/bard/config';

// Mock DB
jest.mock('../../../src/db', () => ({
    getNpcHistory: jest.fn(() => []),
    getCharacterHistory: jest.fn(() => []),
    getOpenQuests: jest.fn(() => [])
}));

// Mock Monitor
jest.mock('../../../src/monitor', () => ({
    monitor: {
        logAIRequestWithCost: jest.fn()
    }
}));

// Mock AI Client
jest.mock('../../../src/bard/config', () => ({
    metadataClient: {
        chat: {
            completions: {
                create: jest.fn()
            }
        }
    },
    METADATA_PROVIDER: 'openai',
    METADATA_MODEL: 'gpt-4o'
}));

describe('Bard Validation - Quest Fallbacks', () => {
    const mockInput = {
        quests: [
            { title: 'Quest A', description: 'Desc A', status: 'OPEN', type: 'MAJOR' }
        ]
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should keep input quests if AI omits them from response', async () => {
        (metadataClient.chat.completions.create as jest.Mock).mockResolvedValue({
            choices: [{ message: { content: JSON.stringify({ npc_events: { keep: [], skip: [] } }) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 }
        });

        const result = await validateBatch(1, mockInput);

        expect(result.quests.keep).toHaveLength(1);
        expect(result.quests.keep[0].title).toBe('Quest A');
    });

    it('should handle flat array response from AI', async () => {
        (metadataClient.chat.completions.create as jest.Mock).mockResolvedValue({
            choices: [{ message: { content: JSON.stringify({ quests: ['Quest B'] }) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 }
        });

        const result = await validateBatch(1, mockInput);

        expect(result.quests.keep).toHaveLength(1);
        expect(result.quests.keep[0].title).toBe('Quest B');
    });

    it('should handle standard keep/skip response from AI', async () => {
        (metadataClient.chat.completions.create as jest.Mock).mockResolvedValue({
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
