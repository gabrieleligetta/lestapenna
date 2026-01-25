import { CommandDispatcher } from '../../../src/commands/index';
import { Client, Message } from 'discord.js';
import { atlasCommand } from '../../../src/commands/locations/atlas';
import { questCommand } from '../../../src/commands/inventory/quest';
import { inventoryCommand } from '../../../src/commands/inventory/inventory';
import * as db from '../../../src/db';

jest.mock('../../../src/db');

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
        (db.getGuildConfig as jest.Mock).mockReturnValue(null);
        process.env.DISCORD_COMMAND_AND_RESPONSE_CHANNEL_ID = '';
    });

    it('should delete Atlas entry fully', async () => {
        // Mock list/get
        (db.listAtlasEntries as jest.Mock).mockReturnValue([{ macro_location: 'Region', micro_location: 'City' }]);
        (db.deleteAtlasEntry as jest.Mock).mockReturnValue(true);

        messageMock.content = '$atlante delete Region | City';
        await dispatcher.dispatch(messageMock);

        expect(db.deleteAtlasRagSummary).toHaveBeenCalledWith(1, 'Region', 'City');
        expect(db.deleteAtlasHistory).toHaveBeenCalledWith(1, 'Region', 'City');
        expect(db.deleteAtlasEntry).toHaveBeenCalledWith(1, 'Region', 'City');
    });

    it('should delete Quest fully', async () => {
        // Mock get
        (db.getQuestByTitle as jest.Mock).mockReturnValue({ id: 10, title: 'Find Sword' });
        (db.deleteQuest as jest.Mock).mockReturnValue(true);

        messageMock.content = '$quest delete Find Sword';
        await dispatcher.dispatch(messageMock);

        expect(db.deleteQuestRagSummary).toHaveBeenCalledWith(1, 'Find Sword');
        expect(db.deleteQuestHistory).toHaveBeenCalledWith(1, 'Find Sword');
        expect(db.deleteQuest).toHaveBeenCalledWith(10);
    });

    it('should delete Inventory item fully', async () => {
        // Mock get/list
        (db.getInventoryItemByName as jest.Mock).mockReturnValue({ id: 22, item_name: 'Potion' });

        messageMock.content = '$loot delete Potion';
        await dispatcher.dispatch(messageMock);

        expect(db.deleteInventoryRagSummary).toHaveBeenCalledWith(1, 'Potion');
        expect(db.deleteInventoryHistory).toHaveBeenCalledWith(1, 'Potion');
        expect(db.removeLoot).toHaveBeenCalledWith(1, 'Potion', expect.any(Number));
    });
});
