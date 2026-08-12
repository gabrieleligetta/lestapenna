
import { IngestionService, isNearDuplicateOfExistingHistory } from '../../../src/publisher/services/IngestionService';
import { addNpcEvent, getNpcEntry } from '../../../src/db';

jest.mock('../../../src/db/repositories/CampaignRepository', () => ({
    campaignRepository: {
        updatePartyAlignment: jest.fn(),
        getFaction: jest.fn(),
        createFaction: jest.fn(),
        updateFaction: jest.fn(),
        getEntityFactions: jest.fn(),
        addAffiliation: jest.fn(),
        addFactionEvent: jest.fn(),
        adjustReputation: jest.fn(),
        setFactionReputation: jest.fn()
    }
}));

jest.mock('../../../src/db', () => ({
    addWorldEvent: jest.fn(),
    getSessionStartTime: jest.fn().mockReturnValue(1234567890),
    getNpcHistory: jest.fn().mockReturnValue([]),
    updateSessionTitle: jest.fn(),
    addCharacterEvent: jest.fn(),
    addNpcEvent: jest.fn(),
    addLoot: jest.fn(),
    removeLoot: jest.fn(),
    addQuest: jest.fn(),
    updateNpcEntry: jest.fn(),
    getNpcEntry: jest.fn(),
    updateLocation: jest.fn(),
    updateAtlasEntry: jest.fn(),
    upsertMonster: jest.fn(),
    updateSessionPresentNPCs: jest.fn(),
    markCharacterDirtyByName: jest.fn(),
    markNpcDirty: jest.fn(),
    markAtlasDirty: jest.fn(),
    clearSessionDerivedData: jest.fn(),
    addSessionLog: jest.fn(),
    addInventoryEvent: jest.fn(),
    addQuestEvent: jest.fn(),
    addBestiaryEvent: jest.fn(),
    addAtlasEvent: jest.fn(),
    getNpcByAlias: jest.fn(),
    campaignRepository: {
        updatePartyAlignment: jest.fn(),
        getFaction: jest.fn(),
        createFaction: jest.fn(),
        updateFaction: jest.fn(),
        getEntityFactions: jest.fn(),
        addAffiliation: jest.fn(),
        addFactionEvent: jest.fn(),
        adjustReputation: jest.fn(),
        setFactionReputation: jest.fn()
    },
    factionRepository: {
        getFaction: jest.fn(),
        createFaction: jest.fn(),
        updateFaction: jest.fn(),
        getEntityFactions: jest.fn(),
        addAffiliation: jest.fn(),
        addFactionEvent: jest.fn(),
        adjustReputation: jest.fn(),
        setFactionReputation: jest.fn(),
        getPartyFaction: jest.fn(),
        getFactionByShortId: jest.fn()
    },
    npcRepository: {
        updateNpcLastSeenLocation: jest.fn(),
        getNpcByShortId: jest.fn().mockReturnValue(null)
    },
    locationRepository: {
        clearSessionLocationHistory: jest.fn(),
        getAtlasEntryByShortId: jest.fn(),
        getAtlasEntryFull: jest.fn()
    }
}));

jest.mock('../../../src/bard', () => ({
    ingestSessionComplete: jest.fn(),
    validateBatch: jest.fn().mockResolvedValue({
        npc_events: { keep: [], skip: [] },
        character_events: { keep: [], skip: [] },
        world_events: { keep: [], skip: [] },
        artifact_events: { keep: [], skip: [] },
        loot: { keep: [], skip: [] },
        loot_removed: { keep: [], skip: [] },
        quests: { keep: [], skip: [] },
        atlas: { action: 'keep', text: '' }
    }),
    ingestBioEvent: jest.fn(),
    ingestWorldEvent: jest.fn(),
    ingestLootEvent: jest.fn(),
    ingestGenericEvent: jest.fn(),
    deduplicateItemBatch: jest.fn().mockResolvedValue([]),
    reconcileItemName: jest.fn(),
    deduplicateNpcBatch: jest.fn().mockImplementation((npcs: any[]) => Promise.resolve(npcs)),
    reconcileNpcName: jest.fn().mockResolvedValue(null),
    smartMergeBios: jest.fn().mockImplementation((_name: string, _old: string, newDesc: string) => Promise.resolve(newDesc)),
    reconcileLocationName: jest.fn(),
    deduplicateLocationBatch: jest.fn().mockResolvedValue([]),
    deduplicateMonsterBatch: jest.fn().mockResolvedValue([]),
    reconcileMonsterName: jest.fn(),
    syncAllDirtyNpcs: jest.fn(),
    syncAllDirtyCharacters: jest.fn(),
    syncAllDirtyAtlas: jest.fn(),
    syncAllDirtyBestiary: jest.fn(),
    syncAllDirtyInventory: jest.fn(),
    syncAllDirtyQuests: jest.fn(),
    syncAllDirtyFactions: jest.fn(),
    cleanEntityName: jest.fn().mockImplementation((name: string) => ({ name, extra: null }))
}));

jest.mock('../../../src/services/SessionPhaseManager', () => ({
    sessionPhaseManager: { setPhase: jest.fn() }
}));

describe('isNearDuplicateOfExistingHistory', () => {
    it('returns false when there is no existing history', () => {
        expect(isNearDuplicateOfExistingHistory('Ha perso il fratello a causa del contagio fungino.', [])).toBe(false);
    });

    it('detects a near-duplicate via word overlap, ignoring case/punctuation', () => {
        const existing = [{ description: 'Ha perso il fratello a causa del contagio fungino che affligge Pestum.' }];
        expect(isNearDuplicateOfExistingHistory('HA PERSO IL FRATELLO a causa del contagio fungino!', existing)).toBe(true);
    });

    it('does not flag unrelated text as a duplicate', () => {
        const existing = [{ description: 'Ha perso il fratello a causa del contagio fungino.' }];
        expect(isNearDuplicateOfExistingHistory('Rivela di conoscere una via segreta verso il Nosocomio.', existing)).toBe(false);
    });

    it('ignores rows without a description', () => {
        expect(isNearDuplicateOfExistingHistory('Testo nuovo qualsiasi.', [{ }])).toBe(false);
    });
});

describe('IngestionService - BACKGROUND event backfill from npc_dossier_updates', () => {
    let service: IngestionService;

    beforeEach(() => {
        service = new IngestionService();
        jest.clearAllMocks();
        (getNpcEntry as jest.Mock).mockReturnValue(null);
    });

    it('persists a new dossier fact as a zero-weight BACKGROUND npc_history event', async () => {
        const campaignId = 2;
        const sessionId = 'session-16';
        const result = {
            npc_dossier_updates: [
                { name: 'Helena', description: 'Ha perso il fratello a causa del contagio fungino.', role: 'Sopravvissuta', status: 'ALIVE' }
            ]
        };

        await service.processBatchEvents(campaignId, sessionId, result);

        expect(addNpcEvent).toHaveBeenCalledWith(
            campaignId,
            'Helena',
            sessionId,
            'Ha perso il fratello a causa del contagio fungino.',
            'BACKGROUND',
            false,
            1234567890,
            0,
            0
        );
    });

    it('does not duplicate a BACKGROUND event when the same fact resurfaces later', async () => {
        const { getNpcHistory } = require('../../../src/db');
        // Simulate the fact already having been persisted in a prior session.
        (getNpcHistory as jest.Mock).mockReturnValue([
            { event_type: 'BACKGROUND', description: 'Ha perso il fratello a causa del contagio fungino.' }
        ]);

        const campaignId = 2;
        const sessionId = 'session-17';
        const result = {
            npc_dossier_updates: [
                { name: 'Helena', description: 'Ha perso il fratello a causa del contagio fungino che affligge la città.', role: 'Guida', status: 'MISSING' }
            ]
        };

        await service.processBatchEvents(campaignId, sessionId, result);

        expect(addNpcEvent).not.toHaveBeenCalledWith(
            expect.anything(), expect.anything(), expect.anything(), expect.anything(),
            'BACKGROUND', expect.anything(), expect.anything(), expect.anything(), expect.anything()
        );
    });
});
