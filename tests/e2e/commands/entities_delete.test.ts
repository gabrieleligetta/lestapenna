import { CommandDispatcher } from '../../../src/commands/index';
import { Client, Message } from 'discord.js';
import { atlasCommand } from '../../../src/commands/locations/atlas';
import { questCommand } from '../../../src/commands/inventory/quest';
import { inventoryCommand } from '../../../src/commands/inventory/inventory';
import * as db from '../../../src/db';

// Mock inventoryRepository direct import in inventory command
jest.mock('../../../src/db/repositories/InventoryRepository', () => ({
    inventoryRepository: {
        getInventoryItemByName: jest.fn(),
        getInventoryItemByShortId: jest.fn(),
        removeLoot: jest.fn(),
        addLoot: jest.fn(),
        getInventory: jest.fn().mockReturnValue([]),
        getSessionInventory: jest.fn().mockReturnValue([]),
        listAllInventory: jest.fn().mockReturnValue([]),
    },
}));

// The cascade deletion is shared with the web CRUD and has its own tests
// (tests/unit/saas/entity-crud.test.ts): here we only verify that the commands
// invoke it with the right family and row, instead of cleaning up by hand.
// The membership check reads from `campaign_members`, a table this
// suite does not have (it mocks `src/db` without initializing the schema). It is covered by
// tests/unit/db/campaign_membership.test.ts.
jest.mock('../../../src/services/campaignAccess', () => ({
    canWriteCampaign: jest.fn().mockReturnValue(true),
    getCampaignRole: jest.fn().mockReturnValue('MASTER'),
    canManageMembership: jest.fn().mockReturnValue(true),
    ensureMembership: jest.fn(),
}));

// An explicit mock, without requireActual: the real module would open the real DB,
// and this suite mocks `src/db` entirely.
jest.mock('../../../src/services/entityDeletion', () => ({
    asRow: (value: unknown) => value ?? null,
    EntityDeleteBlockedError: class EntityDeleteBlockedError extends Error {},
    deleteEntityCascade: jest.fn().mockReturnValue({
        report: {
            history_deleted: 2,
            rag_fragments_deleted: 1,
            rag_refs_stripped: 0,
            affiliations_deleted: 0,
            media_deleted: false,
        },
        mediaObjectKeys: [],
    }),
    purgeOrphanedMediaObjects: jest.fn().mockResolvedValue(undefined),
}));

// Mock interactive modules so they don't open Discord UI
jest.mock('../../../src/commands/locations/interactiveUpdate', () => ({
    startInteractiveAtlasUpdate: jest.fn().mockResolvedValue(undefined),
    startInteractiveAtlasAdd: jest.fn().mockResolvedValue(undefined),
    startInteractiveAtlasDelete: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../src/db', () => ({
    getActiveCampaign: jest.fn(),
    getGuildConfig: jest.fn(),
    listAtlasEntries: jest.fn(),
    listAllAtlasEntries: jest.fn().mockReturnValue([]),
    getAtlasEntryFull: jest.fn(),
    getAtlasEntryByShortId: jest.fn(),
    deleteAtlasEntry: jest.fn(),
    deleteAtlasRagSummary: jest.fn(),
    deleteAtlasHistory: jest.fn(),
    getQuestByTitle: jest.fn(),
    getQuestByShortId: jest.fn(),
    deleteQuest: jest.fn(),
    deleteQuestRagSummary: jest.fn(),
    deleteQuestHistory: jest.fn(),
    getInventoryItemByName: jest.fn(),
    getInventoryItemByShortId: jest.fn(),
    deleteInventoryRagSummary: jest.fn(),
    deleteInventoryHistory: jest.fn(),
    inventoryRepository: {
        getInventoryItemByName: jest.fn(),
        getInventoryItemByShortId: jest.fn(),
        removeLoot: jest.fn(),
        addLoot: jest.fn(),
        getInventory: jest.fn().mockReturnValue([]),
        getSessionInventory: jest.fn().mockReturnValue([]),
        listAllInventory: jest.fn().mockReturnValue([]),
    },
    removeLoot: jest.fn(),
    questRepository: {
        getQuestByShortId: jest.fn(),
        getOpenQuests: jest.fn().mockReturnValue([]),
        getSessionQuests: jest.fn().mockReturnValue([]),
    },
    locationRepository: {
        getAtlasEntryByShortId: jest.fn(),
        getAtlasEntryFull: jest.fn(),
        listAllAtlasEntries: jest.fn().mockReturnValue([]),
        getSessionTravelLog: jest.fn().mockReturnValue([]),
    },
    factionRepository: {
        getPartyFaction: jest.fn().mockReturnValue(null),
        createPartyFaction: jest.fn().mockReturnValue(null),
        ensurePartyMembership: jest.fn(),
    },
}));

import { startInteractiveAtlasDelete } from '../../../src/commands/locations/interactiveUpdate';
import { deleteEntityCascade } from '../../../src/services/entityDeletion';
import { inventoryRepository as mockedInventoryRepo } from '../../../src/db/repositories/InventoryRepository';

describe('Comprehensive Deletion Verification', () => {
    let dispatcher: CommandDispatcher;
    let messageMock: Message;
    let replyMock: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();

        // Setup Dispatcher
        const clientMock = { user: { id: 'bot-id' } } as any;
        dispatcher = new CommandDispatcher(clientMock);
        dispatcher.register(atlasCommand);
        dispatcher.register(questCommand);
        dispatcher.register(inventoryCommand);

        // Setup Message
        replyMock = jest.fn();
        messageMock = {
            author: { id: 'user-1' },
            guild: { id: 'guild-1' },
            channelId: 'channel-1',
            content: '',
            reply: replyMock,
        } as unknown as Message;

        // DB Mock Defaults
        (db.getActiveCampaign as jest.Mock).mockReturnValue({ id: 1, name: 'Campaign 1' });
        (db.getGuildConfig as jest.Mock).mockReturnValue('channel-1');
        process.env.DISCORD_COMMAND_AND_RESPONSE_CHANNEL_ID = '';
    });

    it('should route $atlante delete to interactive deletion flow', async () => {
        // Atlas delete always routes to interactive regardless of args
        messageMock.content = '$atlante delete Region | City';
        await dispatcher.dispatch(messageMock);

        expect(startInteractiveAtlasDelete).toHaveBeenCalled();
    });

    it('should delete Quest through the shared cascade', async () => {
        const quest = { id: 10, title: 'Find Sword' };
        (db.getQuestByTitle as jest.Mock).mockReturnValue(quest);

        messageMock.content = '$quest delete Find Sword';
        await dispatcher.dispatch(messageMock);

        expect(deleteEntityCascade).toHaveBeenCalledWith(1, 'quests', quest);
    });

    it('should delete Inventory item through the shared cascade', async () => {
        const mockItem = { id: 22, item_name: 'Potion' };
        // inventory.ts imports inventoryRepository directly from the repo file, not via db index
        (mockedInventoryRepo.getInventoryItemByName as jest.Mock).mockReturnValue(mockItem);

        messageMock.content = '$loot delete Potion';
        await dispatcher.dispatch(messageMock);

        // There used to be a manual wipe here using `removeLoot(..., 999999)` —
        // the game's "consumption" used as a deletion — which left the
        // relations behind anyway.
        expect(deleteEntityCascade).toHaveBeenCalledWith(1, 'inventory', mockItem);
        expect(mockedInventoryRepo.removeLoot).not.toHaveBeenCalled();
    });

    it('tells the user what the cascade removed besides the entry', async () => {
        (db.getQuestByTitle as jest.Mock).mockReturnValue({ id: 10, title: 'Find Sword' });

        messageMock.content = '$quest delete Find Sword';
        await dispatcher.dispatch(messageMock);

        const messages = replyMock.mock.calls.map(([arg]) =>
            typeof arg === 'string' ? arg : arg?.content ?? '');
        expect(messages.join('\n')).toContain('2 history events and 1 memory fragments');
    });
});
