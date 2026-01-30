
import { IngestionService } from '../../../src/publisher/services/IngestionService';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { addWorldEvent } from '../../../src/db';

// Mock dependencies
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
        setFactionReputation: jest.fn()
    }
}));

jest.mock('../../../src/bard', () => ({
    ingestSessionComplete: jest.fn(),
    validateBatch: jest.fn().mockImplementation((id, input) => {
        // Return dummy valid structure to pass validation check
        return {
            npc_events: { keep: [], skip: [] },
            character_events: { keep: [], skip: [] },
            world_events: { keep: [], skip: [] },
            loot: { keep: [], skip: [] },
            loot_removed: { keep: [], skip: [] },
            quests: { keep: [], skip: [] },
            atlas: { action: 'keep', text: '' }
        };
    }),
    ingestBioEvent: jest.fn(),
    ingestWorldEvent: jest.fn(),
    ingestLootEvent: jest.fn(),
    ingestGenericEvent: jest.fn(),
    deduplicateItemBatch: jest.fn().mockResolvedValue([]),
    reconcileItemName: jest.fn(),
    deduplicateNpcBatch: jest.fn().mockResolvedValue([]),
    reconcileNpcName: jest.fn(),
    smartMergeBios: jest.fn(),
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
    cleanEntityName: jest.fn().mockImplementation((name) => ({ name, extra: null }))
}));

// Mock SessionPhaseManager
jest.mock('../../../src/services/SessionPhaseManager', () => ({
    sessionPhaseManager: {
        setPhase: jest.fn()
    }
}));

describe('IngestionService - Party Alignment', () => {
    let service: IngestionService;

    beforeEach(() => {
        service = new IngestionService();
        jest.clearAllMocks();
    });

    it('should process party_alignment_change correctly', async () => {
        const campaignId = 1;
        const sessionId = 'session-123';
        const result = {
            party_alignment_change: {
                moral: 'BUONO',
                ethical: 'LEGALE',
                reason: 'Heroic deeds and law-abiding behavior'
            }
        };

        await service.processBatchEvents(campaignId, sessionId, result);

        expect(campaignRepository.updatePartyAlignment).toHaveBeenCalledWith(
            campaignId,
            'BUONO',
            'LEGALE'
        );

        expect(addWorldEvent).toHaveBeenCalledWith(
            campaignId,
            sessionId,
            expect.stringContaining('L\'allineamento del gruppo è cambiato: Morale: BUONO Etico: LEGALE'),
            'POLITICS',
            undefined,
            false,
            expect.any(Number)
        );
    });

    it('should process partial alignment change', async () => {
        const campaignId = 1;
        const sessionId = 'session-123';
        const result = {
            party_alignment_change: {
                moral: 'CATTIVO',
                // ethical missing
                reason: 'Murder hoboing'
            }
        };

        await service.processBatchEvents(campaignId, sessionId, result);

        expect(campaignRepository.updatePartyAlignment).toHaveBeenCalledWith(
            campaignId,
            'CATTIVO',
            undefined
        );
    });

    it('should not update if no alignment change provided', async () => {
        const campaignId = 1;
        const sessionId = 'session-123';
        const result = {
            // no party_alignment_change
        };

        await service.processBatchEvents(campaignId, sessionId, result);

        expect(campaignRepository.updatePartyAlignment).not.toHaveBeenCalled();
    });
});
