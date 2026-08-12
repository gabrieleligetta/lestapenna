
import { IngestionService } from '../../../src/publisher/services/IngestionService';
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
        updateNpcLastSeenLocation: jest.fn()
    },
    locationRepository: {
        clearSessionLocationHistory: jest.fn(),
        getAtlasEntryByShortId: jest.fn(),
        getAtlasEntryFull: jest.fn()
    }
}));

jest.mock('../../../src/bard', () => ({
    ingestSessionComplete: jest.fn(),
    validateBatch: jest.fn().mockImplementation((id, input) => {
        return {
            npc_events: { keep: [], skip: [] },
            character_events: { keep: [], skip: [] },
            world_events: { keep: [], skip: [] },
            artifact_events: { keep: [], skip: [] },
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

import {
    factionRepository,
    getNpcEntry,
    locationRepository,
    npcRepository,
    updateLocation
} from '../../../src/db';

describe('IngestionService - Party Alignment', () => {
    let service: IngestionService;

    beforeEach(() => {
        service = new IngestionService();
        jest.clearAllMocks();
        // By default, return a party faction so addFactionEvent can be called
        (factionRepository.getPartyFaction as jest.Mock).mockReturnValue({
            id: 99, name: 'Gli Avventurieri', is_party: 1
        });
        (factionRepository.getFactionByShortId as jest.Mock).mockReturnValue(null);
        (getNpcEntry as jest.Mock).mockReturnValue(null);
        (locationRepository.getAtlasEntryByShortId as jest.Mock).mockReturnValue(null);
        (locationRepository.getAtlasEntryFull as jest.Mock).mockReturnValue(null);
    });

    it('should process party_alignment_change via addFactionEvent', async () => {
        const campaignId = 1;
        const sessionId = 'session-123';
        const result = {
            party_alignment_change: {
                moral_impact: 5,
                ethical_impact: 3,
                reason: 'Heroic deeds and law-abiding behavior'
            }
        };

        await service.processBatchEvents(campaignId, sessionId, result);

        expect(factionRepository.addFactionEvent).toHaveBeenCalledWith(
            campaignId,
            'Gli Avventurieri',
            sessionId,
            expect.stringContaining('Heroic deeds'),
            'GENERIC',
            false,
            0,
            5,
            3,
            expect.any(Number)
        );

        expect(addWorldEvent).toHaveBeenCalledWith(
            campaignId,
            sessionId,
            expect.stringContaining('alignment'),
            'POLITICS',
            undefined,
            false,
            expect.any(Number)
        );
    });

    it('should process partial alignment change (only moral_impact)', async () => {
        const campaignId = 1;
        const sessionId = 'session-123';
        const result = {
            party_alignment_change: {
                moral_impact: -3,
                reason: 'Murder hoboing'
            }
        };

        await service.processBatchEvents(campaignId, sessionId, result);

        expect(factionRepository.addFactionEvent).toHaveBeenCalledWith(
            campaignId,
            'Gli Avventurieri',
            sessionId,
            expect.stringContaining('Murder hoboing'),
            'GENERIC',
            false,
            0,
            -3,
            0,
            expect.any(Number)
        );
    });

    it('should not update if no moral_impact or ethical_impact', async () => {
        const campaignId = 1;
        const sessionId = 'session-123';
        const result = {
            party_alignment_change: {
                // moral_impact and ethical_impact both missing/zero
                reason: 'Nothing happened'
            }
        };

        await service.processBatchEvents(campaignId, sessionId, result);

        expect(factionRepository.addFactionEvent).not.toHaveBeenCalled();
    });

    it('should not update if no alignment change provided', async () => {
        const campaignId = 1;
        const sessionId = 'session-123';
        const result = {};

        await service.processBatchEvents(campaignId, sessionId, result);

        expect(factionRepository.addFactionEvent).not.toHaveBeenCalled();
    });

    it('should resolve faction by short_id when id is provided', async () => {
        const campaignId = 1;
        const sessionId = 'session-123';
        const result = {
            party_alignment_change: {
                id: 'fac01',
                moral_impact: 2,
                reason: 'Test'
            }
        };

        (factionRepository.getFactionByShortId as jest.Mock).mockReturnValue({
            id: 5, name: 'Fazione Test', is_party: 0
        });

        await service.processBatchEvents(campaignId, sessionId, result);

        expect(factionRepository.getFactionByShortId).toHaveBeenCalledWith(campaignId, 'fac01');
        expect(factionRepository.addFactionEvent).toHaveBeenCalledWith(
            campaignId,
            'Fazione Test',
            sessionId,
            expect.any(String),
            'GENERIC',
            false,
            0,
            2,
            0,
            expect.any(Number)
        );
    });

    it('should not stamp all present NPCs with final party location in multi-location sessions', async () => {
        const campaignId = 1;
        const sessionId = 'session-123';
        const result = {
            present_npcs: ['Helena', 'Ivonne'],
            travel_sequence: [
                { macro: 'Paestum', micro: 'Città in rovina' },
                { macro: 'Caelum', micro: 'Ateneo' }
            ]
        };

        await service.processBatchEvents(campaignId, sessionId, result);

        expect(locationRepository.clearSessionLocationHistory).toHaveBeenCalledWith(sessionId);
        expect(updateLocation).toHaveBeenCalledTimes(2);
        expect(npcRepository.updateNpcLastSeenLocation).not.toHaveBeenCalled();
    });

    it('should update NPC last_seen_location from explicit npc_locations resolved through atlas id', async () => {
        const campaignId = 1;
        const sessionId = 'session-123';
        const result = {
            present_npcs: ['Helena', 'Ivonne'],
            npc_locations: [
                { name: 'Helena', location_id: 'pae01' }
            ],
            travel_sequence: [
                { macro: 'Paestum', micro: 'Città in rovina' },
                { macro: 'Caelum', micro: 'Ateneo' }
            ]
        };

        (getNpcEntry as jest.Mock).mockReturnValue({ name: 'Helena' });
        (locationRepository.getAtlasEntryByShortId as jest.Mock).mockReturnValue({
            macro_location: 'Paestum',
            micro_location: 'Città in rovina'
        });

        await service.processBatchEvents(campaignId, sessionId, result);

        expect(npcRepository.updateNpcLastSeenLocation).toHaveBeenCalledTimes(1);
        expect(npcRepository.updateNpcLastSeenLocation).toHaveBeenCalledWith(
            campaignId,
            'Helena',
            'Paestum - Città in rovina'
        );
    });
});
