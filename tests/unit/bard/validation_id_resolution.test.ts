
import { validateBatch } from '../../../src/bard/validation';
import { metadataClient } from '../../../src/bard/config';
import {
    npcRepository,
    characterRepository,
    artifactRepository,
    inventoryRepository,
    questRepository,
    locationRepository,
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
    },
    locationRepository: {
        getAtlasEntryByShortId: jest.fn()
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

    it('should resolve Loot Removed matched name using shortId and preserve ID', async () => {
        const input = {
            loot_removed: [
                { id: 'lr01', name: 'Old Sword', quantity: 1 }
            ]
        };

        (inventoryRepository.getInventoryItemByShortId as jest.Mock).mockReturnValue({ item_name: 'Rusty Sword' });

        (metadataClient.chat.completions.create as jest.Mock).mockResolvedValue({
            usage: {},
            choices: [{
                message: {
                    content: JSON.stringify({
                        loot_removed: {
                            keep: [{ name: 'Rusty Sword', quantity: 1 }],
                            skip: []
                        }
                    })
                }
            }]
        });

        const result = await validateBatch(1, input);

        expect(inventoryRepository.getInventoryItemByShortId).toHaveBeenCalledWith(1, 'lr01');
        expect(result.loot_removed.keep[0].name).toBe('Rusty Sword');
        expect(result.loot_removed.keep[0]).toHaveProperty('id', 'lr01');
    });

    it('should resolve Character canonical name using User ID and preserve ID', async () => {
        const input = {
            character_events: [
                { id: 'user123', name: 'Player Name', event: 'Leveled up', type: 'ACHIEVEMENT' }
            ]
        };

        (characterRepository.getUserProfile as jest.Mock).mockReturnValue({ character_name: 'Thorin Oakenshield' });

        (metadataClient.chat.completions.create as jest.Mock).mockResolvedValue({
            usage: {},
            choices: [{
                message: {
                    content: JSON.stringify({
                        character_events: {
                            keep: [{ name: 'Thorin Oakenshield', event: 'Leveled up', type: 'ACHIEVEMENT' }],
                            skip: []
                        }
                    })
                }
            }]
        });

        const result = await validateBatch(1, input);

        expect(characterRepository.getUserProfile).toHaveBeenCalledWith('user123', 1);
        expect(result.character_events.keep[0]).toHaveProperty('id', 'user123');
        expect(result.character_events.keep[0]).toHaveProperty('name', 'Thorin Oakenshield');
    });

    it('should resolve World Event location using shortId and log the match', async () => {
        const input = {
            world_events: [
                { id: 'loc01', event: 'A great fire broke out', type: 'CALAMITY' }
            ]
        };

        (locationRepository.getAtlasEntryByShortId as jest.Mock).mockReturnValue({
            macro_location: 'Waterdeep',
            micro_location: 'Market District'
        });

        (metadataClient.chat.completions.create as jest.Mock).mockResolvedValue({
            usage: {},
            choices: [{
                message: {
                    content: JSON.stringify({
                        world_events: {
                            keep: [{ id: 'loc01', event: 'A great fire broke out', type: 'CALAMITY' }],
                            skip: []
                        }
                    })
                }
            }]
        });

        const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

        await validateBatch(1, input);

        expect(locationRepository.getAtlasEntryByShortId).toHaveBeenCalledWith(1, 'loc01');
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('[World Event] 🎯 ID Match: loc01 → Waterdeep - Market District')
        );

        consoleSpy.mockRestore();
    });

    it('should log ID Match for all entity types when resolution succeeds', async () => {
        const input = {
            npc_events: [{ id: 'npc01', name: 'Wrong', event: 'Met', type: 'MEETING' }],
            artifact_events: [{ id: 'art01', name: 'Wrong', event: 'Found', type: 'DISCOVERY' }],
            quests: [{ id: 'q01', title: 'Wrong', status: 'OPEN' }],
            loot: [{ id: 'l01', name: 'Wrong', quantity: 1 }]
        };

        (npcRepository.getNpcByShortId as jest.Mock).mockReturnValue({ name: 'Correct NPC' });
        (artifactRepository.getArtifactByShortId as jest.Mock).mockReturnValue({ name: 'Correct Artifact' });
        (questRepository.getQuestByShortId as jest.Mock).mockReturnValue({ title: 'Correct Quest' });
        (inventoryRepository.getInventoryItemByShortId as jest.Mock).mockReturnValue({ item_name: 'Correct Item' });

        (metadataClient.chat.completions.create as jest.Mock).mockResolvedValue({
            usage: {},
            choices: [{
                message: {
                    content: JSON.stringify({
                        npc_events: { keep: [{ name: 'Correct NPC', event: 'Met', type: 'MEETING' }], skip: [] },
                        artifact_events: { keep: [{ name: 'Correct Artifact', event: 'Found', type: 'DISCOVERY' }], skip: [] },
                        quests: { keep: [{ title: 'Correct Quest', status: 'OPEN' }], skip: [] },
                        loot: { keep: [{ name: 'Correct Item', quantity: 1 }], skip: [] }
                    })
                }
            }]
        });

        const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

        await validateBatch(1, input);

        // Verify all entity types logged their ID Match
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[NPC Event] 🎯 ID Match: npc01 → Correct NPC'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Artifact Event] 🎯 ID Match: art01 → Correct Artifact'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Quest Event] 🎯 ID Match: q01 → Correct Quest'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Loot Event] 🎯 ID Match: l01 → Correct Item'));

        consoleSpy.mockRestore();
    });
});
