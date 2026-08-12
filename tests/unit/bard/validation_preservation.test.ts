
import { validateBatch } from '../../../src/bard/validation';
import { getMetadataClient } from '../../../src/bard/config';

// Mock getMetadataClient
jest.mock('../../../src/bard/config', () => ({
    ...jest.requireActual('../../../src/bard/config'),
    getMetadataClient: jest.fn()
}));

// Mock the moral reassessment second-pass: this file tests validateBatch's own
// ID/impact-preservation logic, not the reassessment feature (covered separately in
// moralReassessment.test.ts) — echo candidates back unchanged so BETRAYAL-tier fixtures
// here don't trigger real client construction / network calls.
jest.mock('../../../src/bard/moralReassessment', () => ({
    reassessNpcMoralWeights: jest.fn(async (candidates: any[]) => candidates.map(c => ({
        name: c.name,
        moral_impact: c.moral_impact,
        ethical_impact: c.ethical_impact,
        motive: 'mocked: unchanged'
    })))
}));

// Mock DB dependencies
jest.mock('../../../src/db', () => ({
    getNpcHistory: jest.fn().mockReturnValue([]),
    getCharacterHistory: jest.fn().mockReturnValue([]),
    getOpenQuests: jest.fn().mockReturnValue([]),
    npcRepository: { getNpcByShortId: jest.fn().mockReturnValue(null) },
    characterRepository: { getUserProfile: jest.fn().mockReturnValue(null) },
    artifactRepository: { getArtifactByShortId: jest.fn().mockReturnValue(null), getArtifactHistory: jest.fn().mockReturnValue([]) },
    inventoryRepository: { getInventoryItemByShortId: jest.fn().mockReturnValue(null) },
    questRepository: { getQuestByShortId: jest.fn().mockReturnValue(null) },
    locationRepository: { getAtlasEntryByShortId: jest.fn().mockReturnValue(null) },
}));

describe('validateBatch ID Preservation', () => {
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
            world_events: [],
            loot: [],
            loot_removed: [],
            quests: []
        };

        mockCreate.mockResolvedValue({
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

        expect(result.npc_events.keep[0]).toHaveProperty('id', 'npc01');
        expect(result.character_events.keep[0]).toHaveProperty('id', 'pc01');
        expect(result.artifact_events.keep[0]).toHaveProperty('id', 'art01');

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

        mockCreate.mockResolvedValue({
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

        mockCreate.mockResolvedValue({
            usage: { prompt_tokens: 100, completion_tokens: 50 },
            choices: [{
                message: {
                    content: JSON.stringify({
                        npc_events: {
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
