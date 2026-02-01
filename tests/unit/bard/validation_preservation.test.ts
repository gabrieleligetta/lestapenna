
import { validateBatch } from '../../../src/bard/validation';
import { metadataClient } from '../../../src/bard/config';

// Mock metadataClient
jest.mock('../../../src/bard/config', () => ({
    ...jest.requireActual('../../../src/bard/config'),
    metadataClient: {
        chat: {
            completions: {
                create: jest.fn()
            }
        }
    }
}));

// Mock DB dependencies
jest.mock('../../../src/db', () => ({
    getNpcHistory: jest.fn().mockReturnValue([]),
    getCharacterHistory: jest.fn().mockReturnValue([]),
    getOpenQuests: jest.fn().mockReturnValue([])
}));

describe('validateBatch ID Preservation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should hydrate IDs from input when AI omits them', async () => {
        const input = {
            npc_events: [
                { id: 'npc01', name: 'Gundren Rockseeker', event: 'Found alive', type: 'STATUS_CHANGE' }
            ],
            character_events: [
                { id: 'pc01', name: 'Test Subject', event: 'Leveled up', type: 'GROWTH' }
            ],
            artifact_events: [
                { id: 'art01', name: 'Dragon Mask', event: 'Activated', type: 'ACTIVATION' }
            ],
            // Add required fields
            world_events: [],
            loot: [],
            loot_removed: [],
            quests: []
        };

        // Mock AI response omitting IDs but keeping names
        (metadataClient.chat.completions.create as jest.Mock).mockResolvedValue({
            usage: { prompt_tokens: 100, completion_tokens: 50 },
            choices: [{
                message: {
                    content: JSON.stringify({
                        npc_events: {
                            keep: [{ name: 'Gundren Rockseeker', event: 'Found alive in improved condition', type: 'STATUS_CHANGE' }],
                            skip: []
                        },
                        character_events: {
                            keep: [{ name: 'Test Subject', event: 'Gained a level', type: 'GROWTH' }],
                            skip: []
                        },
                        artifact_events: {
                            keep: [{ name: 'Dragon Mask', event: 'Glowed with power', type: 'ACTIVATION' }],
                            skip: []
                        }
                    })
                }
            }]
        });

        const result = await validateBatch(1, input);

        // Verify IDs were re-attached
        expect(result.npc_events.keep[0]).toHaveProperty('id', 'npc01');
        expect(result.character_events.keep[0]).toHaveProperty('id', 'pc01');
        expect(result.artifact_events.keep[0]).toHaveProperty('id', 'art01');

        // Verify descriptions were taken from AI (proof that we didn't just ignore AI)
        expect(result.npc_events.keep[0].event).toBe('Found alive in improved condition');
    });

    it('should preserve moral and ethical impact from input', async () => {
        const input = {
            npc_events: [
                { id: 'npc03', name: 'Leosin Erantar', event: 'Betrayed party', type: 'BETRAYAL', moral_impact: -8, ethical_impact: -9 }
            ],
            character_events: [],
            artifact_events: [],
            world_events: [],
            loot: [],
            loot_removed: [],
            quests: []
        };

        // Mock AI response omitting impacts
        (metadataClient.chat.completions.create as jest.Mock).mockResolvedValue({
            usage: { prompt_tokens: 100, completion_tokens: 50 },
            choices: [{
                message: {
                    content: JSON.stringify({
                        npc_events: {
                            keep: [{ name: 'Leosin Erantar', event: 'Confirmed betrayal', type: 'BETRAYAL' }],
                            skip: []
                        },
                        character_events: { keep: [], skip: [] },
                        artifact_events: { keep: [], skip: [] }
                    })
                }
            }]
        });

        const result = await validateBatch(1, input);

        expect(result.npc_events.keep[0]).toHaveProperty('id', 'npc03');
        expect(result.npc_events.keep[0]).toHaveProperty('moral_impact', -8);
        expect(result.npc_events.keep[0]).toHaveProperty('ethical_impact', -9);
    });

    it('should match case-insensitively when merging', async () => {
        const input = {
            npc_events: [
                { id: 'npc02', name: 'Sildar Hallwinter', event: 'Arrived', type: 'EVENT' }
            ],
            character_events: [],
            artifact_events: [],
            world_events: [],
            loot: [],
            loot_removed: [],
            quests: []
        };

        (metadataClient.chat.completions.create as jest.Mock).mockResolvedValue({
            usage: { prompt_tokens: 100, completion_tokens: 50 },
            choices: [{
                message: {
                    content: JSON.stringify({
                        npc_events: {
                            // Lowercase name in output
                            keep: [{ name: 'sildar hallwinter', event: 'Arrived safely', type: 'EVENT' }],
                            skip: []
                        }
                    })
                }
            }]
        });

        const result = await validateBatch(1, input);

        expect(result.npc_events.keep[0]).toHaveProperty('id', 'npc02');
    });
});
