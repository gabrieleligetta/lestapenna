
import { reconcileNpcName } from '../../../src/bard/reconciliation/npc';
import { reconcileItemName } from '../../../src/bard/reconciliation/item';
import { reconcileLocationName } from '../../../src/bard/reconciliation/location';
import { reconcileMonsterName } from '../../../src/bard/reconciliation/monster';
import { reconcileQuestTitle } from '../../../src/bard/reconciliation/quest';

// 1. Mock DB
jest.mock('../../../src/db', () => ({
    listNpcs: jest.fn(),
    getAllNpcs: jest.fn(),
    listAllInventory: jest.fn(),
    listAllAtlasEntries: jest.fn(),
    listAllMonsters: jest.fn(),
    listAllQuests: jest.fn(),
}));

jest.mock('../../../src/bard/rag', () => ({
    searchKnowledge: jest.fn().mockResolvedValue([])
}));

// 2. Mock AI client
jest.mock('../../../src/bard/config', () => ({
    metadataClient: {
        chat: {
            completions: {
                create: jest.fn()
            }
        }
    },
    METADATA_MODEL: 'test-model'
}));

import { listNpcs, getAllNpcs, listAllInventory, listAllAtlasEntries, listAllMonsters, listAllQuests } from '../../../src/db';
import { metadataClient } from '../../../src/bard/config';

describe('Reconciliation Case-Sensitivity Deduplication', () => {
    const CAMPAIGN_ID = 1;

    beforeEach(() => {
        jest.clearAllMocks();
        // Default mock implementation for AI to say YES
        (metadataClient.chat.completions.create as jest.Mock).mockResolvedValue({
            choices: [{ message: { content: 'YES' } }]
        });
    });

    describe('NPC Reconciliation', () => {
        it('should return existing canonical NPC when name matches case-insensitively', async () => {
            (getAllNpcs as jest.Mock).mockReturnValue([
                { id: 101, name: 'Leosin Erantar', description: 'Monk' }
            ]);

            const result = await reconcileNpcName(CAMPAIGN_ID, 'leosin erantar', 'Some monk');

            expect(result).not.toBeNull();
            expect(result?.canonicalName).toBe('Leosin Erantar');
            // Ensure AI was NOT called for exact match
            expect(metadataClient.chat.completions.create).not.toHaveBeenCalled();
        });

        it('should reconcile fuzzy matches (approximate name)', async () => {
            (getAllNpcs as jest.Mock).mockReturnValue([
                { id: 101, name: 'Leosin Erantar', description: 'Monk' }
            ]);

            // "eosin rantar" is similar to "Leosin Erantar"
            const result = await reconcileNpcName(CAMPAIGN_ID, 'eosin rantar', 'Some monk');

            expect(result).not.toBeNull();
            expect(result?.canonicalName).toBe('Leosin Erantar');
            // Ensure AI WAS called for fuzzy match
            expect(metadataClient.chat.completions.create).toHaveBeenCalled();
        });

        it('should handle "Il Respiro" vs "Respiro di Ogma" even with other Ogma entities', async () => {
            (getAllNpcs as jest.Mock).mockReturnValue([
                { id: 101, name: 'Pensiero di Ogma', description: 'Altro Arcangelo' },
                { id: 102, name: 'Il Respiro', description: 'Aspetto di Ogma' }, // The correct match
                { id: 103, name: 'Forma di Ogma', description: 'Altro Arcangelo' }
            ]);

            // Setup AI mock to reject "Pensiero" but accept "Il Respiro"
            (metadataClient.chat.completions.create as jest.Mock).mockImplementation(async (args) => {
                const prompt = args.messages[0].content;
                if (prompt.includes('Pensiero di Ogma')) return { choices: [{ message: { content: 'NO' } }] };
                if (prompt.includes('Forma di Ogma')) return { choices: [{ message: { content: 'NO' } }] };
                if (prompt.includes('Il Respiro')) return { choices: [{ message: { content: 'YES' } }] };
                return { choices: [{ message: { content: 'NO' } }] };
            });

            const result = await reconcileNpcName(CAMPAIGN_ID, 'Respiro di Ogma', 'Arcangelo');

            expect(result).not.toBeNull();
            expect(result?.canonicalName).toBe('Il Respiro');
        });

        it('should reconcile Siri/Ciri based on phonetic similarity and new prompt logic', async () => {
            // Mock existing Siri (adult)
            (getAllNpcs as jest.Mock).mockReturnValue([
                { id: 200, name: 'Siri', description: 'Donna adulta dallo sguardo gelido e distaccato; contenitore della Voce di Ogma.' }
            ]);

            // Mock AI to say YES for Ciri (child)
            (metadataClient.chat.completions.create as jest.Mock).mockImplementation(async (args) => {
                const prompt = args.messages[0].content;
                // Verify new prompt keywords are present
                expect(prompt.toLowerCase()).toContain('trasformazioni');
                expect(prompt.toLowerCase()).toContain('fonetica');

                if (prompt.includes('Siri')) return { choices: [{ message: { content: 'SI' } }] };
                return { choices: [{ message: { content: 'NO' } }] };
            });

            const result = await reconcileNpcName(CAMPAIGN_ID, 'Ciri', 'bambina con tre occhi, voce di Ogma');

            expect(result).not.toBeNull();
            expect(result?.canonicalName).toBe('Siri');
        });
    });

    describe('Item Reconciliation', () => {
        it('should return existing canonical Item when name matches case-insensitively', async () => {
            (listAllInventory as jest.Mock).mockReturnValue([
                { id: 201, item_name: 'Potion of Healing' }
            ]);

            const result = await reconcileItemName(CAMPAIGN_ID, 'potion of healing');

            expect(result).not.toBeNull();
            expect(result?.canonicalName).toBe('Potion of Healing');
            expect(metadataClient.chat.completions.create).not.toHaveBeenCalled();
        });

        it('should reconcile fuzzy matches', async () => {
            (listAllInventory as jest.Mock).mockReturnValue([
                { id: 201, item_name: 'Potion of Healing' }
            ]);

            const result = await reconcileItemName(CAMPAIGN_ID, 'Potion Healing'); // Missing "of"

            expect(result).not.toBeNull();
            expect(result?.canonicalName).toBe('Potion of Healing');
            expect(metadataClient.chat.completions.create).toHaveBeenCalled();
        });
    });

    describe('Location Reconciliation', () => {
        it('should return existing canonical Location when name matches case-insensitively', async () => {
            (listAllAtlasEntries as jest.Mock).mockReturnValue([
                { id: 301, macro_location: 'Greenest', micro_location: 'Keep' }
            ]);

            const result = await reconcileLocationName(CAMPAIGN_ID, 'greenest', 'keep');

            expect(result).not.toBeNull();
            expect(result?.canonicalMacro).toBe('Greenest');
            expect(result?.canonicalMicro).toBe('Keep');
            expect(metadataClient.chat.completions.create).not.toHaveBeenCalled();
        });

        it('should reconcile fuzzy matches', async () => {
            (listAllAtlasEntries as jest.Mock).mockReturnValue([
                { id: 301, macro_location: 'Greenest', micro_location: 'Keep' }
            ]);

            const result = await reconcileLocationName(CAMPAIGN_ID, 'Greenst', 'Kep'); // Typo

            expect(result).not.toBeNull();
            expect(result?.canonicalMacro).toBe('Greenest');
            expect(metadataClient.chat.completions.create).toHaveBeenCalled();
        });
    });

    describe('Monster Reconciliation', () => {
        it('should return existing canonical Monster when name matches case-insensitively', async () => {
            (listAllMonsters as jest.Mock).mockReturnValue([
                { id: 401, name: 'Goblin Boss' }
            ]);

            const result = await reconcileMonsterName(CAMPAIGN_ID, 'goblin boss');

            expect(result).not.toBeNull();
            expect(result?.canonicalName).toBe('Goblin Boss');
            expect(metadataClient.chat.completions.create).not.toHaveBeenCalled();
        });

        it('should reconcile fuzzy matches', async () => {
            (listAllMonsters as jest.Mock).mockReturnValue([
                { id: 401, name: 'Goblin Boss' }
            ]);

            const result = await reconcileMonsterName(CAMPAIGN_ID, 'Goblin Bos'); // Typo

            expect(result).not.toBeNull();
            expect(result?.canonicalName).toBe('Goblin Boss');
            expect(metadataClient.chat.completions.create).toHaveBeenCalled();
        });
    });

    describe('Quest Reconciliation', () => {
        it('should return existing canonical Quest when title matches case-insensitively', async () => {
            (listAllQuests as jest.Mock).mockReturnValue([
                { id: 501, title: 'Rescue Leosin' }
            ]);

            const result = await reconcileQuestTitle(CAMPAIGN_ID, 'rescue leosin');

            expect(result).not.toBeNull();
            expect(result?.canonicalTitle).toBe('Rescue Leosin');
            expect(metadataClient.chat.completions.create).not.toHaveBeenCalled();
        });

        it('should reconcile fuzzy matches', async () => {
            (listAllQuests as jest.Mock).mockReturnValue([
                { id: 501, title: 'Rescue Leosin' }
            ]);

            const result = await reconcileQuestTitle(CAMPAIGN_ID, 'Rescu Leosin'); // Typo

            expect(result).not.toBeNull();
            expect(result?.canonicalTitle).toBe('Rescue Leosin');
            expect(metadataClient.chat.completions.create).toHaveBeenCalled();
        });
    });


    describe('Feature: Strip Prefixes & Smart Fuzzy', () => {

        it('should reconcile "The Sword" vs "Sword" (Item)', async () => {
            (listAllInventory as jest.Mock).mockReturnValue([
                { id: 202, item_name: 'Sword of Justice' }
            ]);
            // "The Sword of Justice" -> strip "The" -> "Sword of Justice" -> Match
            const result = await reconcileItemName(CAMPAIGN_ID, 'The Sword of Justice');
            expect(result?.canonicalName).toBe('Sword of Justice');
        });

        it('should reconcile "La Palude" vs "Palude dei Morti" (Location)', async () => {
            (listAllAtlasEntries as jest.Mock).mockReturnValue([
                { id: 302, macro_location: 'Regione', micro_location: 'Palude dei Morti' }
            ]);
            // "La Palude dei Morti" -> strip "La" -> "Palude dei Morti" -> Match
            const result = await reconcileLocationName(CAMPAIGN_ID, 'Regione', 'La Palude dei Morti');
            expect(result?.canonicalMicro).toBe('Palude dei Morti');
        });

        it('should reconcile "Un Goblin" vs "Goblin Warrior" (Monster)', async () => {
            (listAllMonsters as jest.Mock).mockReturnValue([
                { id: 402, name: 'Goblin Warrior' }
            ]);
            // "Un Goblin Warrior" -> strip "Un" -> "Goblin Warrior" -> Match
            const result = await reconcileMonsterName(CAMPAIGN_ID, 'Un Goblin Warrior');
            expect(result?.canonicalName).toBe('Goblin Warrior');
        });

        it('should reconcile "A Rescue Mission" vs "Rescue Mission" (Quest)', async () => {
            (listAllQuests as jest.Mock).mockReturnValue([
                { id: 502, title: 'Rescue Mission' }
            ]);
            // "A Rescue Mission" -> strip "A" -> "Rescue Mission" -> Match
            const result = await reconcileQuestTitle(CAMPAIGN_ID, 'A Rescue Mission');
            expect(result?.canonicalTitle).toBe('Rescue Mission');
        });
    });
});
