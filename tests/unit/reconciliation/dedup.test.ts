
import { reconcileNpcName } from '../../../src/bard/reconciliation/npc';
import { reconcileItemName } from '../../../src/bard/reconciliation/item';
import { reconcileLocationName } from '../../../src/bard/reconciliation/location';
import { reconcileMonsterName } from '../../../src/bard/reconciliation/monster';
import { reconcileQuestTitle } from '../../../src/bard/reconciliation/quest';

// 1. Mock DB
jest.mock('../../../src/db', () => ({
    listNpcs: jest.fn(),
    listAllInventory: jest.fn(),
    listAllAtlasEntries: jest.fn(),
    listAllMonsters: jest.fn(),
    listAllQuests: jest.fn(),
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

import { listNpcs, listAllInventory, listAllAtlasEntries, listAllMonsters, listAllQuests } from '../../../src/db';
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
            (listNpcs as jest.Mock).mockReturnValue([
                { id: 101, name: 'Leosin Erantar', description: 'Monk' }
            ]);

            const result = await reconcileNpcName(CAMPAIGN_ID, 'leosin erantar', 'Some monk');

            expect(result).not.toBeNull();
            expect(result?.canonicalName).toBe('Leosin Erantar');
            // Ensure AI was NOT called for exact match
            expect(metadataClient.chat.completions.create).not.toHaveBeenCalled();
        });

        it('should reconcile fuzzy matches (approximate name)', async () => {
            (listNpcs as jest.Mock).mockReturnValue([
                { id: 101, name: 'Leosin Erantar', description: 'Monk' }
            ]);

            // "eosin rantar" is similar to "Leosin Erantar"
            const result = await reconcileNpcName(CAMPAIGN_ID, 'eosin rantar', 'Some monk');

            expect(result).not.toBeNull();
            expect(result?.canonicalName).toBe('Leosin Erantar');
            // Ensure AI WAS called for fuzzy match
            expect(metadataClient.chat.completions.create).toHaveBeenCalled();
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
});
