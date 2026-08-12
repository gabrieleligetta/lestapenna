import { addLoot, createCampaign, deleteCampaign, getInventoryItemByShortId } from '../../../src/db';
import { db } from '../../../src/db/client';
import { inventoryRepository } from '../../../src/db/repositories/InventoryRepository';

describe('addLoot category guess', () => {
    let campaignId: number;

    beforeAll(() => {
        campaignId = createCampaign('Test Inventory Category Campaign', 'test');
    });

    afterAll(() => {
        deleteCampaign(campaignId);
    });

    it('guesses a category for a newly created item instead of leaving it at the OTHER default', () => {
        addLoot(campaignId, 'Pozione di cura', 1, 'session-1', undefined, true);
        const row = db.prepare('SELECT short_id FROM inventory WHERE item_name = ? AND campaign_id = ?')
            .get('Pozione di cura', campaignId) as { short_id: string };

        const item = getInventoryItemByShortId(campaignId, row.short_id);
        expect(item?.category).toBe('CONSUMABLE');
    });

    it('falls back to OTHER when nothing matches', () => {
        addLoot(campaignId, 'Ciondolo strano', 1, 'session-1', undefined, true);
        const row = db.prepare('SELECT short_id FROM inventory WHERE item_name = ? AND campaign_id = ?')
            .get('Ciondolo strano', campaignId) as { short_id: string };

        const item = getInventoryItemByShortId(campaignId, row.short_id);
        expect(item?.category).toBe('OTHER');
    });

    it('does not touch category on quantity updates to an existing item', () => {
        addLoot(campaignId, 'Ascia arrugginita', 1, 'session-1', undefined, true);
        const row = db.prepare('SELECT id, short_id FROM inventory WHERE item_name = ? AND campaign_id = ?')
            .get('Ascia arrugginita', campaignId) as { id: number; short_id: string };
        expect(getInventoryItemByShortId(campaignId, row.short_id)?.category).toBe('WEAPON');

        // Manual override, then a follow-up loot add for the same item name.
        inventoryRepository.updateInventoryCategory(campaignId, row.short_id, 'TREASURE');
        addLoot(campaignId, 'Ascia arrugginita', 1, 'session-2', undefined, true);

        expect(getInventoryItemByShortId(campaignId, row.short_id)?.category).toBe('TREASURE');
    });

    it('uses the AI-supplied category on insert instead of the keyword heuristic', () => {
        // Name/description would heuristically match WEAPON ("pugnale"), but the AI's
        // narrative-aware classification (QUEST_ITEM) should win.
        addLoot(campaignId, 'Pugnale del patto', 1, 'session-1', undefined, false, undefined, 'QUEST_ITEM');
        const row = db.prepare('SELECT short_id FROM inventory WHERE item_name = ? AND campaign_id = ?')
            .get('Pugnale del patto', campaignId) as { short_id: string };

        expect(getInventoryItemByShortId(campaignId, row.short_id)?.category).toBe('QUEST_ITEM');
    });

    it('falls back to the heuristic when the AI-supplied category is invalid or omitted', () => {
        addLoot(campaignId, 'Amuleto dimenticato', 1, 'session-1', undefined, false, undefined, 'NOT_A_REAL_CATEGORY' as any);
        const row = db.prepare('SELECT short_id FROM inventory WHERE item_name = ? AND campaign_id = ?')
            .get('Amuleto dimenticato', campaignId) as { short_id: string };

        expect(getInventoryItemByShortId(campaignId, row.short_id)?.category).toBe('OTHER');
    });
});
