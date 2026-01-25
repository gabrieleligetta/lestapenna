
import { createCampaignCommand } from '../../../src/commands/campaigns/create';
import { selectCampaignCommand } from '../../../src/commands/campaigns/select';
import { deleteCampaignCommand } from '../../../src/commands/campaigns/delete';
import { listCampaignsCommand } from '../../../src/commands/campaigns/list';
import { CommandContext } from '../../../src/commands/types';
import { EmbedBuilder, TextChannel, Message } from 'discord.js';

// Mock DB
jest.mock('../../../src/db', () => ({
    createCampaign: jest.fn(),
    getCampaigns: jest.fn(),
    setActiveCampaign: jest.fn(),
    getActiveCampaign: jest.fn(),
    deleteCampaign: jest.fn(),
}));

import * as db from '../../../src/db';

describe('Campaign Commands', () => {
    let mockContext: CommandContext;
    let replyMock: jest.Mock;
    let channelMock: any;

    beforeEach(() => {
        jest.clearAllMocks();
        replyMock = jest.fn();

        channelMock = {
            awaitMessages: jest.fn().mockResolvedValue({ size: 0 }),
            send: jest.fn()
        };

        mockContext = {
            message: {
                reply: replyMock,
                author: { id: 'user-1' },
                channel: channelMock,
            } as any,
            args: [],
            guildId: 'guild-1',
            activeCampaign: null,
            client: {} as any,
        };
    });

    describe('Create Campaign', () => {
        it('should create campaign with provided name', async () => {
            mockContext.args = ['Nuova', 'Campagna'];
            (db.createCampaign as jest.Mock).mockReturnValue(1);

            await createCampaignCommand.execute(mockContext);

            expect(db.createCampaign).toHaveBeenCalledWith('guild-1', 'Nuova Campagna');
            expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Nuova Campagna'));
        });

        it('should show error if no name provided', async () => {
            mockContext.args = [];
            await createCampaignCommand.execute(mockContext);
            expect(db.createCampaign).not.toHaveBeenCalled();
            expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Uso:'));
        });
    });

    describe('Select Campaign', () => {
        it('should select campaign by name', async () => {
            mockContext.args = ['Test'];
            (db.getCampaigns as jest.Mock).mockReturnValue([
                { id: 1, name: 'Test', guild_id: 'guild-1' }
            ]);

            await selectCampaignCommand.execute(mockContext);

            expect(db.setActiveCampaign).toHaveBeenCalledWith('guild-1', 1);
            expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Test'));
        });

        it('should select campaign by ID', async () => {
            mockContext.args = ['1'];
            (db.getCampaigns as jest.Mock).mockReturnValue([
                { id: 1, name: 'Test', guild_id: 'guild-1' }
            ]);

            await selectCampaignCommand.execute(mockContext);

            expect(db.setActiveCampaign).toHaveBeenCalledWith('guild-1', 1);
        });

        it('should show error if campaign not found', async () => {
            mockContext.args = ['NonEsiste'];
            (db.getCampaigns as jest.Mock).mockReturnValue([]);

            await selectCampaignCommand.execute(mockContext);

            expect(db.setActiveCampaign).not.toHaveBeenCalled();
            expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('non trovata'));
        });
    });

    describe('Delete Campaign', () => {
        it('should delete campaign after confirmation', async () => {
            mockContext.args = ['Test'];
            (db.getCampaigns as jest.Mock).mockReturnValue([
                { id: 1, name: 'Test', guild_id: 'guild-1' }
            ]);

            // Mock user confirmation
            channelMock.awaitMessages.mockResolvedValue({
                size: 1,
                first: () => ({ content: 'CONFERMO' })
            });

            await deleteCampaignCommand.execute(mockContext);

            expect(channelMock.awaitMessages).toHaveBeenCalled();
            expect(db.deleteCampaign).toHaveBeenCalledWith(1);
            expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('eliminata definitivamente'));
        });

        it('should not delete if not confirmed', async () => {
            mockContext.args = ['Test'];
            (db.getCampaigns as jest.Mock).mockReturnValue([
                { id: 1, name: 'Test', guild_id: 'guild-1' }
            ]);

            // Mock timeout
            channelMock.awaitMessages.mockRejectedValue(new Error('time'));

            await deleteCampaignCommand.execute(mockContext);

            expect(db.deleteCampaign).not.toHaveBeenCalled();
            expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Tempo scaduto'));
        });
    });

    describe('List Campaigns', () => {
        it('should list campaigns and mark active one', async () => {
            (db.getCampaigns as jest.Mock).mockReturnValue([
                { id: 1, name: 'Campagna 1' },
                { id: 2, name: 'Campagna 2' }
            ]);
            (db.getActiveCampaign as jest.Mock).mockReturnValue({ id: 2 });

            // Mock collector creation
            const collectorMock = {
                on: jest.fn(),
                stop: jest.fn()
            };
            replyMock.mockResolvedValue({
                createMessageComponentCollector: jest.fn().mockReturnValue(collectorMock)
            });

            await listCampaignsCommand.execute(mockContext);

            expect(replyMock).toHaveBeenCalled();
            const callArgs = replyMock.mock.calls[0][0];
            const embed = callArgs.embeds[0] as EmbedBuilder;

            // Check descriptions
            expect(embed.data.description).toContain('Campagna 1');
            expect(embed.data.description).toContain('👉 **Campagna 2**');
        });

        it('should warn if no campaigns exist', async () => {
            (db.getCampaigns as jest.Mock).mockReturnValue([]);
            await listCampaignsCommand.execute(mockContext);
            expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Nessuna campagna trovata'));
        });
    });
});
