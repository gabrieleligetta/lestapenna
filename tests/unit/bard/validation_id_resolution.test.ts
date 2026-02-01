
import { validateBatch } from '../../../src/bard/validation';
import { metadataClient } from '../../../src/bard/config';
import {
    npcRepository,
    characterRepository,
    artifactRepository,
    inventoryRepository,
    questRepository,
    getNpcHistory,
    getCharacterHistory,
    getOpenQuests
} from '../../../src/db';

// Mock dependencies
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

jest.mock('../../../src/db', () => ({
    getNpcHistory: jest.fn().mockReturnValue([]),
    getCharacterHistory: jest.fn().mockReturnValue([]),
    getOpenQuests: jest.fn().mockReturnValue([]),
    npcRepository: {
        getNpcByShortId: jest.fn()
    },
    characterRepository: {
        getUserProfile: jest.fn()
    },
    artifactRepository: {
        getArtifactByShortId: jest.fn(),
        getArtifactHistory: jest.fn().mockReturnValue([])
    },
    inventoryRepository: {
        getInventoryItemByShortId: jest.fn()
    },
    questRepository: {
        getQuestByShortId: jest.fn()
    }
}));

describe('validateBatch ID Resolution', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should resolve NPC canonical name using shortId and preserve ID in output', async () => {
        const input = {
            npc_events: [
                { id: 'npc01', name: 'Wrong Name', event: 'Met party', type: 'MEETING' }
            ]
        };

        // Mock Repository Lookup
        (npcRepository.getNpcByShortId as jest.Mock).mockReturnValue({ name: 'Canonical Name' });

        // Mock AI Response (AI might return corrected name, but maybe no ID)
        (metadataClient.chat.completions.create as jest.Mock).mockResolvedValue({
            usage: {},
            choices: [{
                message: {
                    content: JSON.stringify({
                        npc_events: {
                            keep: [{ name: 'Canonical Name', event: 'Met party', type: 'MEETING' }],
                            skip: []
                        }
                    })
                }
            }]
        });

        const result = await validateBatch(1, input);

        // Verify Repository was called with Correct ID
        expect(npcRepository.getNpcByShortId).toHaveBeenCalledWith(1, 'npc01');

        // Verify Output has ID preserved from input
        expect(result.npc_events.keep[0]).toHaveProperty('id', 'npc01');
        // Verify Name was canonicalized in logic (though AI return takes precedence in merge, 
        // the context would have sent 'Canonical Name' to AI).
    });

    it('should resolve Artifact canonical name using shortId and preserve ID', async () => {
        const input = {
            artifact_events: [
                { id: 'art01', name: 'Unknown Item', event: 'Found', type: 'DISCOVERY' }
            ]
        };

        (artifactRepository.getArtifactByShortId as jest.Mock).mockReturnValue({ name: 'Excalibur' });

        (metadataClient.chat.completions.create as jest.Mock).mockResolvedValue({
            usage: {},
            choices: [{
                message: {
                    content: JSON.stringify({
                        artifact_events: {
                            keep: [{ name: 'Excalibur', event: 'Found', type: 'DISCOVERY' }],
                            skip: []
                        }
                    })
                }
            }]
        });

        const result = await validateBatch(1, input);

        expect(artifactRepository.getArtifactByShortId).toHaveBeenCalledWith(1, 'art01');
        expect(result.artifact_events.keep[0]).toHaveProperty('id', 'art01');
        expect(result.artifact_events.keep[0]).toHaveProperty('name', 'Excalibur');
    });

    it('should resolve Quest title using shortId and preserve ID', async () => {
        const input = {
            quests: [
                { id: 'q01', title: 'Kill Rats', status: 'OPEN' }
            ]
        };

        (questRepository.getQuestByShortId as jest.Mock).mockReturnValue({ title: 'Epic Rat Slayer' });

        (metadataClient.chat.completions.create as jest.Mock).mockResolvedValue({
            usage: {},
            choices: [{
                message: {
                    content: JSON.stringify({
                        quests: {
                            keep: [{ title: 'Epic Rat Slayer', status: 'OPEN' }],
                            skip: []
                        }
                    })
                }
            }]
        });

        const result = await validateBatch(1, input);

        expect(questRepository.getQuestByShortId).toHaveBeenCalledWith(1, 'q01');
        expect(result.quests.keep[0].title).toBe('Epic Rat Slayer');
        expect(result.quests.keep[0]).toHaveProperty('id', 'q01');
    });

    it('should resolve Loot matched name using shortId and preserve ID', async () => {
        const input = {
            loot: [
                { id: 'l01', name: 'Gold Coin', quantity: 10 }
            ]
        };

        (inventoryRepository.getInventoryItemByShortId as jest.Mock).mockReturnValue({ item_name: 'Gold Pieces' });

        (metadataClient.chat.completions.create as jest.Mock).mockResolvedValue({
            usage: {},
            choices: [{
                message: {
                    content: JSON.stringify({
                        loot: {
                            keep: [{ name: 'Gold Pieces', quantity: 10 }],
                            skip: []
                        }
                    })
                }
            }]
        });

        const result = await validateBatch(1, input);

        expect(inventoryRepository.getInventoryItemByShortId).toHaveBeenCalledWith(1, 'l01');
        expect(result.loot.keep[0].name).toBe('Gold Pieces');
        expect(result.loot.keep[0]).toHaveProperty('id', 'l01');
    });
});
