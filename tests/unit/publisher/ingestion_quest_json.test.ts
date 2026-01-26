
process.env.DISCORD_BOT_TOKEN = 'mock-token';
process.env.DISCORD_CLIENT_ID = 'mock-client-id';

import { IngestionService } from '../../../src/publisher/services/IngestionService';
import { validateBatch } from '../../../src/bard/validation';
import * as db from '../../../src/db';

// Mock dependencies
jest.mock('../../../src/bard/validation');
jest.mock('../../../src/db', () => ({
    addQuest: jest.fn(),
    addQuestEvent: jest.fn(),
    getSessionStartTime: jest.fn(() => 123456789),
    updateSessionPresentNPCs: jest.fn(),
    addSessionLog: jest.fn(),
    updateLocation: jest.fn(),
    upsertMonster: jest.fn(),
    addBestiaryEvent: jest.fn(),
    addNpcEvent: jest.fn(),
    addCharacterEvent: jest.fn(),
    addWorldEvent: jest.fn(),
    addLoot: jest.fn(),
    addInventoryEvent: jest.fn(),
    markNpcDirty: jest.fn(),
    markAtlasDirty: jest.fn(),
    markCharacterDirtyByName: jest.fn(),
    getNpcIdByName: jest.fn()
}));

// Mock RAG
jest.mock('../../../src/bard/rag', () => ({
    ingestBioEvent: jest.fn(),
    ingestWorldEvent: jest.fn(),
    ingestLootEvent: jest.fn(),
    ingestGenericEvent: jest.fn(),
    ingestSessionComplete: jest.fn()
}));

// Mock Sync
jest.mock('../../../src/bard/sync', () => ({
    syncAllDirtyNpcs: jest.fn(),
    syncAllDirtyCharacters: jest.fn(),
    syncAllDirtyAtlas: jest.fn(),
    syncAllDirtyBestiary: jest.fn(),
    syncAllDirtyInventory: jest.fn(),
    syncAllDirtyQuests: jest.fn(),
    cleanEntityName: (n: string) => ({ name: n, extra: null })
}));

describe('IngestionService - Quest JSON Test', () => {
    const ingestionService = new IngestionService();

    const userJson = {
        "quests": [
            {
                "title": "Raggiungere il pensatoio di Ogma",
                "description": "Il gruppo attiva il cerchio di teletrasporto con la parola di comando e fugge dalla Mano; viene poi guidato da 'Il Respiro' che conferma che dopo la Forma di Ogma troveranno il pensatoio. Il Respiro attiva un ulteriore teletrasporto verso il livello superiore dove li attende la Forma di Ogma e due pari.",
                "status": "OPEN",
                "type": "MAJOR"
            }
        ]
    };

    it('should correctly process and save the quest from the provided JSON', async () => {
        // Simulate validateBatch returning the quest as "keep" 
        // (This happens if AI confirms it OR if our new fallback kicks in)
        (validateBatch as jest.Mock).mockResolvedValue({
            npc_events: { keep: [], skip: [] },
            character_events: { keep: [], skip: [] },
            world_events: { keep: [], skip: [] },
            loot: { keep: [], skip: [] },
            loot_removed: { keep: [], skip: [] },
            quests: {
                keep: [...userJson.quests],
                skip: []
            },
            atlas: { action: 'keep' }
        });

        await ingestionService.processBatchEvents(1, 'test-session', userJson);

        // Verify addQuest was called with the correct data
        expect(db.addQuest).toHaveBeenCalledWith(
            1, // campaignId
            "Raggiungere il pensatoio di Ogma", // title
            "test-session", // sessionId
            expect.stringContaining("Il gruppo attiva il cerchio"), // description
            "OPEN", // status
            "MAJOR", // type
            false, // manual
            expect.any(Number) // timestamp
        );

        // Verify history was also tracked
        expect(db.addQuestEvent).toHaveBeenCalledWith(
            1,
            "Raggiungere il pensatoio di Ogma",
            "test-session",
            expect.any(String),
            "PROGRESS",
            false,
            expect.any(Number)
        );
    });
});
