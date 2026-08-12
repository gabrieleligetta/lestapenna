
import { createCampaignCommand } from '../../../src/commands/campaigns/create';
import { selectCampaignCommand } from '../../../src/commands/campaigns/select';
import { deleteCampaignCommand } from '../../../src/commands/campaigns/delete';
import { listCampaignsCommand } from '../../../src/commands/campaigns/list';
import { CommandContext } from '../../../src/commands/types';
import { EmbedBuilder, TextChannel, Message } from 'discord.js';

// Mock interactiveUpdate to avoid Discord component complexity
jest.mock('../../../src/commands/campaigns/interactiveUpdate', () => ({
    startInteractiveCampaignCreate: jest.fn()
}));

// Mock DB
jest.mock('../../../src/db', () => ({
    createCampaign: jest.fn(),
    getCampaigns: jest.fn(),
    setActiveCampaign: jest.fn(),
    getActiveCampaign: jest.fn(),
    deleteCampaign: jest.fn(),
    factionRepository: {
        createPartyFaction: jest.fn()
    }
}));

// The birth of a campaign (row + party faction + enrolling the creator
// as MASTER) lives in a service shared with the web app.
const createCampaignWithPartyMock = jest.fn();
jest.mock('../../../src/services/campaignSetup', () => ({
    createCampaignWithParty: (...args: unknown[]) => createCampaignWithPartyMock(...args),
}));

// The spoken-language wizard is a Discord interactive flow of its own.
jest.mock('../../../src/commands/utils/campaignLanguage', () => ({
    promptCampaignLanguage: jest.fn().mockResolvedValue(undefined),
}));

// Deleting a campaign goes through the erasure service, not straight to the
// repository: the row deletion alone left the recordings, their transcripts and
// every object in the bucket behind.
const eraseCampaignDataMock = jest.fn().mockResolvedValue({ rows: {}, objects: 0, localFiles: 0, failedPrefixes: [] });
jest.mock('../../../src/services/dataErasure', () => ({
    eraseCampaignData: (...args: unknown[]) => eraseCampaignDataMock(...args),
}));

import * as db from '../../../src/db';
import { startInteractiveCampaignCreate } from '../../../src/commands/campaigns/interactiveUpdate';

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
            locale: 'it' as const,
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
        it('should create campaign with provided name and make the author master', async () => {
            mockContext.args = ['Nuova', 'Campagna'];
            createCampaignWithPartyMock.mockReturnValue({ id: 1, name: 'Nuova Campagna', guild_id: 'guild-1' });

            await createCampaignCommand.execute(mockContext);

            expect(createCampaignWithPartyMock).toHaveBeenCalledWith({
                guildId: 'guild-1',
                name: 'Nuova Campagna',
                creatorUserId: 'user-1',
            });
            expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Nuova Campagna'));
        });

        it('should start interactive creation if no name provided', async () => {
            mockContext.args = [];
            await createCampaignCommand.execute(mockContext);
            expect(createCampaignWithPartyMock).not.toHaveBeenCalled();
            expect(startInteractiveCampaignCreate).toHaveBeenCalledWith(mockContext);
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
            expect(eraseCampaignDataMock).toHaveBeenCalledWith(1);
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

            expect(eraseCampaignDataMock).not.toHaveBeenCalled();
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
