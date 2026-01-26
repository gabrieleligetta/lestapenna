import Database from 'better-sqlite3';
import {
    initDatabase,
    db,
    addQuest,
    getOpenQuests,
    getQuestByShortId,
    updateQuestStatus,
    updateNpcEntry,
    getNpcByShortId,
    updateAtlasEntry,
    getAtlasEntryByShortId,
    upsertMonster,
    getMonsterByShortId,
    addLoot,
    getInventoryItemByShortId,
    createCampaign,
    deleteCampaign
} from '../../../src/db';
import {
    generateShortId
} from '../../../src/db/utils/idGenerator';
import { QuestStatus } from '../../../src/db/types';

// Mock DB location to avoiding messing with prod
const TEST_DB = ':memory:';

describe('Universal Short ID & Quest Status Tests', () => {
    let campaignId: number;

    beforeAll(() => {
        // Create a test campaign
        try {
            const result = createCampaign('Test Unit Campaign', 'test');
            campaignId = result;
        } catch (e) {
            console.error("Failed to create test campaign:", e);
            throw e;
        }
    });

    afterAll(() => {
        // Cleanup
        if (campaignId) {
            deleteCampaign(campaignId);
        }
    });

    test('Short ID Generation should return 5-char alphanumeric string', () => {
        const sid = generateShortId('quests');
        expect(sid).toMatch(/^[a-z0-9]{5}$/);
    });

    test('Quest Status: IN_PROGRESS quests should be returned by getOpenQuests', () => {
        // 1. Add a quest
        const title = 'Test Quest In Progress';
        addQuest(campaignId, title, 'session-1', 'Desc', QuestStatus.OPEN, 'MAJOR', true);

        // 2. Update to IN_PROGRESS
        updateQuestStatus(campaignId, title, QuestStatus.IN_PROGRESS);

        // 3. Fetch open quests
        const open = getOpenQuests(campaignId);
        const myQuest = open.find((q: any) => q.title === title);

        expect(myQuest).toBeDefined();
        expect(myQuest?.status).toBe(QuestStatus.IN_PROGRESS);
        expect(myQuest?.short_id).toMatch(/^[a-z0-9]{5}$/);
    });

    test('Repository Lookup by Short ID', () => {

        // NPC
        const npcName = 'Test NPC SID';
        updateNpcEntry(campaignId, npcName, 'Desc', 'Role', 'ALIVE', undefined, true);

        // We can't easily get the Short ID without querying by name first.
        const dbInstance = require('../../../src/db').db;
        const npcRecord = dbInstance.prepare('SELECT short_id FROM npc_dossier WHERE name = ? AND campaign_id = ?').get(npcName, campaignId);
        console.log("NPC Record found:", npcRecord);
        expect(npcRecord.short_id).toBeDefined();

        const retrievedNpc = getNpcByShortId(campaignId, npcRecord.short_id);
        console.log("Retrieved NPC by Short ID:", retrievedNpc);
        expect(retrievedNpc).toBeDefined();
        expect(retrievedNpc?.name).toBe(npcName);

        // Location
        const macro = 'Test Macro';
        const micro = 'Test Micro';
        updateAtlasEntry(campaignId, macro, micro, 'Desc', undefined, true);
        const atlasRecord = dbInstance.prepare('SELECT short_id FROM location_atlas WHERE macro_location = ? AND micro_location = ? AND campaign_id = ?').get(macro, micro, campaignId);
        expect(atlasRecord.short_id).toBeDefined();

        const retrievedAtlas = getAtlasEntryByShortId(campaignId, atlasRecord.short_id);
        expect(retrievedAtlas).toBeDefined();
        expect(retrievedAtlas?.macro_location).toBe(macro);

        // Bestiary
        const monsterName = 'Test Monster SID';
        upsertMonster(campaignId, monsterName, 'ALIVE', '1', 'session-1', undefined, undefined, true);
        const monsterRecord = dbInstance.prepare('SELECT short_id FROM bestiary WHERE name = ? AND campaign_id = ?').get(monsterName, campaignId);
        expect(monsterRecord.short_id).toBeDefined();

        const retrievedMonster = getMonsterByShortId(campaignId, monsterRecord.short_id);
        expect(retrievedMonster).toBeDefined();
        expect(retrievedMonster?.name).toBe(monsterName);

        // Inventory
        const itemName = 'Test Item SID';
        addLoot(campaignId, itemName, 1, 'session-1', undefined, true);
        const itemRecord = dbInstance.prepare('SELECT short_id FROM inventory WHERE item_name = ? AND campaign_id = ?').get(itemName, campaignId);
        expect(itemRecord.short_id).toBeDefined();

        const retrievedItem = getInventoryItemByShortId(campaignId, itemRecord.short_id);
        expect(retrievedItem).toBeDefined();
        expect(retrievedItem?.item_name).toBe(itemName);
    });
});
