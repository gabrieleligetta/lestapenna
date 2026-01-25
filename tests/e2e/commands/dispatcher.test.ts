
import { CommandDispatcher } from '../../../src/commands/index';
import { Command } from '../../../src/commands/types';
import { Client, Message } from 'discord.js';

// Mock DB
jest.mock('../../../src/db', () => ({
    getActiveCampaign: jest.fn(),
    getGuildConfig: jest.fn(),
}));

import { getActiveCampaign, getGuildConfig } from '../../../src/db';

describe('CommandDispatcher Integration', () => {
    let clientMock: Client;
    let messageMock: Message;
    let dispatcher: CommandDispatcher;
    let testCommand: Command;
    let replyMock: jest.Mock;

    beforeEach(() => {
        // Reset mocks
        jest.clearAllMocks();

        // Mock Client
        clientMock = {} as Client;

        // Mock Message
        replyMock = jest.fn();
        messageMock = {
            author: { bot: false },
            guild: { id: 'guild-123' },
            content: '$test arg1',
            channelId: 'channel-123',
            reply: replyMock,
        } as unknown as Message;

        // Mock DB responses by default
        (getActiveCampaign as jest.Mock).mockReturnValue(null);
        (getGuildConfig as jest.Mock).mockReturnValue(null); // No specific channel restriction

        // Setup Dispatcher
        dispatcher = new CommandDispatcher(clientMock);

        // Setup Test Command
        testCommand = {
            name: 'test',
            aliases: ['t'],
            requiresCampaign: false,
            execute: jest.fn(),
        };
        dispatcher.register(testCommand);
    });

    it('should dispatch command when prefix matches', async () => {
        const result = await dispatcher.dispatch(messageMock);
        expect(result).toBe(true);
        expect(testCommand.execute).toHaveBeenCalled();
        const ctx = (testCommand.execute as jest.Mock).mock.calls[0][0];
        expect(ctx.args).toEqual(['arg1']);
        expect(ctx.guildId).toBe('guild-123');
    });

    it('should ignore bot messages', async () => {
        messageMock.author.bot = true;
        const result = await dispatcher.dispatch(messageMock);
        expect(result).toBe(false);
        expect(testCommand.execute).not.toHaveBeenCalled();
    });

    it('should respect channel restrictions', async () => {
        (getGuildConfig as jest.Mock).mockReturnValue('channel-999'); // Restrict to channel-999
        messageMock.channelId = 'channel-123'; // User is in channel-123

        const result = await dispatcher.dispatch(messageMock);
        expect(result).toBe(false);
        expect(testCommand.execute).not.toHaveBeenCalled();
    });

    it('should allow command in restricted channel', async () => {
        (getGuildConfig as jest.Mock).mockReturnValue('channel-123');
        messageMock.channelId = 'channel-123';

        const result = await dispatcher.dispatch(messageMock);
        expect(result).toBe(true);
        expect(testCommand.execute).toHaveBeenCalled();
    });

    it('should block command requiring campaign if none active', async () => {
        testCommand.requiresCampaign = true;
        (getActiveCampaign as jest.Mock).mockReturnValue(null);

        const result = await dispatcher.dispatch(messageMock);
        expect(result).toBe(true); // Handled (by sending error)
        expect(testCommand.execute).not.toHaveBeenCalled();
        expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Nessuna campagna attiva'));
    });
});
