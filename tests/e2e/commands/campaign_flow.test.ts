
import { CommandDispatcher } from '../../../src/commands/index';
import { Client, Message, TextChannel } from 'discord.js';
import { createCampaignCommand } from '../../../src/commands/campaigns/create';
import { selectCampaignCommand } from '../../../src/commands/campaigns/select';
import { listCampaignsCommand } from '../../../src/commands/campaigns/list';
import { deleteCampaignCommand } from '../../../src/commands/campaigns/delete';

// Mock Modules
jest.mock('../../../src/db');
import * as db from '../../../src/db';

describe('Campaign E2E Flow', () => {
    let clientMock: Client;
    let dispatcher: CommandDispatcher;
    let messageMock: Message;
    let replyMock: jest.Mock;
    let channelMock: any;

    // Stateful DB Mock
    let validCampaigns: any[] = [];
    let activeCampaignId: number | null = null;

    beforeEach(() => {
        jest.clearAllMocks();

        // Reset DB State
        validCampaigns = [];
        activeCampaignId = null;

        // DB Mocks Implementation
        (db.createCampaign as jest.Mock).mockImplementation((guild, name) => {
            const newId = validCampaigns.length + 1;
            validCampaigns.push({ id: newId, name, guild_id: guild });
            return newId;
        });
        (db.getCampaigns as jest.Mock).mockImplementation((guild) => validCampaigns);
        (db.setActiveCampaign as jest.Mock).mockImplementation((guild, id) => { activeCampaignId = id; });
        (db.getActiveCampaign as jest.Mock).mockImplementation((guild) => {
            return validCampaigns.find(c => c.id === activeCampaignId) || null;
        });
        (db.deleteCampaign as jest.Mock).mockImplementation((id) => {
            validCampaigns = validCampaigns.filter(c => c.id !== id);
            if (activeCampaignId === id) activeCampaignId = null;
        });
        (db.getGuildConfig as jest.Mock).mockReturnValue(null); // No channel restriction

        // Setup Dispatcher
        clientMock = { user: { id: 'bot-id' } } as any;
        dispatcher = new CommandDispatcher(clientMock);

        // Register Commands (manually or via index if exported)
        dispatcher.register(createCampaignCommand);
        dispatcher.register(selectCampaignCommand);
        dispatcher.register(listCampaignsCommand);
        dispatcher.register(deleteCampaignCommand);

        // Setup Message Mock
        replyMock = jest.fn();
        channelMock = {
            id: 'channel-1',
            awaitMessages: jest.fn().mockResolvedValue({ size: 0 }), // Default timeout
            send: jest.fn()
        };

        messageMock = {
            author: { id: 'user-1', bot: false },
            guild: { id: 'guild-1' },
            channel: channelMock,
            content: '',
            reply: replyMock,
            member: { voice: { channel: null } }
        } as unknown as Message;
    });

    it('should allow full campaign lifecycle', async () => {
        // 1. Create Campaign "Alpha"
        messageMock.content = '$creacampagna Alpha';
        await dispatcher.dispatch(messageMock);
        expect(validCampaigns).toHaveLength(1);
        expect(validCampaigns[0].name).toBe('Alpha');

        // 2. Select Campaign "Alpha"
        messageMock.content = '$selezionacampagna Alpha';
        await dispatcher.dispatch(messageMock);
        expect(activeCampaignId).toBe(1);

        // 3. List Campaigns
        messageMock.content = '$listacampagne';
        // Mock collector for list command
        let lastEmbed: any;
        replyMock.mockImplementationOnce(async (opts) => {
            lastEmbed = opts.embeds[0];
            return { createMessageComponentCollector: jest.fn().mockReturnValue({ on: jest.fn(), stop: jest.fn() }) };
        });

        await dispatcher.dispatch(messageMock);
        expect(lastEmbed.data.description).toContain('👉 **Alpha**');

        // 4. Create Campaign "Beta"
        messageMock.content = '$creacampagna Beta';
        await dispatcher.dispatch(messageMock);
        expect(validCampaigns).toHaveLength(2);

        // 5. Delete Campaign "Alpha"
        messageMock.content = '$eliminacampagna Alpha';
        // Mock user confirmation
        channelMock.awaitMessages.mockResolvedValueOnce({
            size: 1,
            first: () => ({ content: 'CONFERMO' })
        });

        await dispatcher.dispatch(messageMock);
        expect(validCampaigns).toHaveLength(1);
        expect(validCampaigns[0].name).toBe('Beta');
        expect(activeCampaignId).toBeNull(); // Was active, now deleted
    });
});
