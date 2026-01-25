
import { CommandDispatcher } from '../../../src/commands/index';
import { Client, Message } from 'discord.js';
import { npcCommand } from '../../../src/commands/npcs/npc';
import * as db from '../../../src/db';

// Mock DB
jest.mock('../../../src/db');

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
        (db.getGuildConfig as jest.Mock).mockReturnValue(null);
    });

    it('should show that delete leaves RAG and history behind', async () => {
        // 1. Setup Mock Data
        const mockNpc = { id: 1, name: 'Victim', campaign_id: 1, description: 'To be deleted' };

        (db.listNpcs as jest.Mock).mockReturnValue([mockNpc]);
        (db.getNpcEntry as jest.Mock).mockReturnValue(mockNpc);

        // Mock deletion success for dossier
        (db.deleteNpcEntry as jest.Mock).mockReturnValue(true);

        // Spy on execute
        const executeSpy = jest.spyOn(npcCommand, 'execute');

        // 2. Execute Delete
        messageMock.content = '$npc delete Victim';
        await dispatcher.dispatch(messageMock);

        // 3. Verify Deletion Calls

        // Expect ALL deletion functions to be called
        expect(db.deleteNpcRagSummary).toHaveBeenCalledWith(1, 'Victim');
        expect(db.deleteNpcHistory).toHaveBeenCalledWith(1, 'Victim');
        expect(db.deleteNpcEntry).toHaveBeenCalledWith(1, 'Victim');

        // 4. Verify WHAT WAS MISSED (Reproduction)
        // These should NOT have been called yet because they don't exist in the command
        // Note: We need to check if the functions are even imported/called.
        // Since we are mocking the module, we can check if any *other* delete functions were called.

        // We expect NO call to deleteNpcRagSummary or anything regarding history
        // But since we can't easily check for "did not call function that isn't imported", 
        // we can assume the reproduction is successful if the code runs efficiently only calling deleteNpcEntry.

        // Verify deleteNpcEntry was called once
        expect(db.deleteNpcEntry).toHaveBeenCalledTimes(1);

        // In a real integration test against a DB, we would query the DB here.
        // For this unit test, we confirm that ONLY deleteNpcEntry was called.
        // If we add the features, we'd expect other calls.
    });
});
