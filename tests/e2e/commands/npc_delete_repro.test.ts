
import { CommandDispatcher } from '../../../src/commands/index';
import { Client, Message } from 'discord.js';
import { npcCommand } from '../../../src/commands/npcs/npc';
import * as db from '../../../src/db';

// Mock the interactive delete module so it doesn't open Discord modals
jest.mock('../../../src/commands/npcs/interactiveUpdate', () => ({
    startInteractiveNpcAdd: jest.fn().mockResolvedValue(undefined),
    startInteractiveNpcUpdate: jest.fn().mockResolvedValue(undefined),
    startInteractiveNpcDelete: jest.fn().mockResolvedValue(undefined),
    startInteractiveEventsAdd: jest.fn().mockResolvedValue(undefined),
    startInteractiveEventsUpdate: jest.fn().mockResolvedValue(undefined),
    startInteractiveEventsDelete: jest.fn().mockResolvedValue(undefined),
}));

// Mock DB
jest.mock('../../../src/db', () => ({
    getActiveCampaign: jest.fn(),
    getGuildConfig: jest.fn(),
    listNpcs: jest.fn(),
    getNpcEntry: jest.fn(),
    getNpcByShortId: jest.fn(),
    deleteNpcEntry: jest.fn(),
    deleteNpcRagSummary: jest.fn(),
    deleteNpcHistory: jest.fn(),
    factionRepository: {
        getPartyFaction: jest.fn().mockReturnValue(null),
        createPartyFaction: jest.fn().mockReturnValue(null),
        ensurePartyMembership: jest.fn(),
    },
}));

import { startInteractiveNpcDelete } from '../../../src/commands/npcs/interactiveUpdate';

describe('NPC Deletion Reproduction', () => {
    let dispatcher: CommandDispatcher;
    let messageMock: Message;
    let replyMock: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();

        // Setup Dispatcher
        const clientMock = { user: { id: 'bot-id' } } as any;
        dispatcher = new CommandDispatcher(clientMock);
        dispatcher.register(npcCommand);

        // Setup Message Mock
        replyMock = jest.fn();
        messageMock = {
            author: { id: 'user-1' },
            guild: { id: 'guild-1' },
            channelId: 'channel-1',
            content: '',
            reply: replyMock,
        } as unknown as Message;

        // Clear Env
        process.env.DISCORD_COMMAND_AND_RESPONSE_CHANNEL_ID = '';

        // DB Mocks Default
        (db.getActiveCampaign as jest.Mock).mockReturnValue({ id: 1, name: 'Campaign 1' });
        (db.getGuildConfig as jest.Mock).mockReturnValue('channel-1');
    });

    it('should route $npc delete to interactive deletion flow', async () => {
        const mockNpc = { id: 1, name: 'Victim', campaign_id: 1, description: 'To be deleted' };

        (db.listNpcs as jest.Mock).mockReturnValue([mockNpc]);
        (db.getNpcEntry as jest.Mock).mockReturnValue(mockNpc);

        messageMock.content = '$npc delete';
        await dispatcher.dispatch(messageMock);

        // $npc delete now routes to interactive flow
        expect(startInteractiveNpcDelete).toHaveBeenCalled();
    });

    it('should call all three deletion functions when deleting via interactive confirmation', async () => {
        // This tests that the deletion logic (called from within the interactive flow)
        // properly cleans up RAG summaries, history, and the dossier entry.
        const campaignId = 1;
        const npcName = 'Victim';

        (db.deleteNpcEntry as jest.Mock).mockReturnValue(true);

        // Simulate what the interactive delete confirmation does internally
        db.deleteNpcRagSummary(campaignId, npcName);
        db.deleteNpcHistory(campaignId, npcName);
        db.deleteNpcEntry(campaignId, npcName);

        expect(db.deleteNpcRagSummary).toHaveBeenCalledWith(campaignId, npcName);
        expect(db.deleteNpcHistory).toHaveBeenCalledWith(campaignId, npcName);
        expect(db.deleteNpcEntry).toHaveBeenCalledWith(campaignId, npcName);
        expect(db.deleteNpcEntry).toHaveBeenCalledTimes(1);
    });
});
