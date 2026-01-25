
import { helpCommand } from '../../../src/commands/help/help';
import { CommandContext } from '../../../src/commands/types';
import { EmbedBuilder } from 'discord.js';

describe('Help Command', () => {
    let mockContext: CommandContext;
    let replyMock: jest.Mock;

    beforeEach(() => {
        replyMock = jest.fn();
        mockContext = {
            message: {
                reply: replyMock,
            } as any,
            args: [],
            guildId: 'test-guild',
            activeCampaign: null,
            client: {} as any,
        };
    });

    it('should show basic help when no args provided', async () => {
        await helpCommand.execute(mockContext);

        expect(replyMock).toHaveBeenCalledTimes(1);
        const callArgs = replyMock.mock.calls[0][0];
        const embed = callArgs.embeds[0] as EmbedBuilder;

        expect(embed.data.title).toContain('Basic Commands');
        expect(embed.data.description).toContain('Essential commands');
    });

    it('should show advanced help when "advanced" arg provided', async () => {
        mockContext.args = ['advanced'];
        await helpCommand.execute(mockContext);

        expect(replyMock).toHaveBeenCalledTimes(1);
        const callArgs = replyMock.mock.calls[0][0];
        const embed = callArgs.embeds[0] as EmbedBuilder;

        expect(embed.data.title).toContain('Advanced Commands');
        expect(embed.data.fields).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: expect.stringContaining('Campaigns') }),
                expect.objectContaining({ name: expect.stringContaining('Danger Zone') })
            ])
        );
    });

    it('should show developer help when "dev" arg provided', async () => {
        mockContext.args = ['dev'];
        await helpCommand.execute(mockContext);

        expect(replyMock).toHaveBeenCalledTimes(1);
        const callArgs = replyMock.mock.calls[0][0];
        const embed = callArgs.embeds[0] as EmbedBuilder;

        expect(embed.data.title).toContain('Developer Tools');
    });
});
