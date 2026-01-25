
import { CommandDispatcher } from '../../../src/commands/index';
import { Client, Message } from 'discord.js';
import { debugCommand } from '../../../src/commands/admin/debug';

// Mock Env
process.env.DISCORD_BOT_TOKEN = 'mock-token';

// Mock Modules
jest.mock('fs');
jest.mock('better-sqlite3', () => {
    return jest.fn().mockImplementation(() => ({
        pragma: jest.fn(),
        prepare: jest.fn().mockReturnValue({ get: jest.fn(), run: jest.fn() }),
        exec: jest.fn()
    }));
});
jest.mock('child_process', () => ({
    exec: jest.fn()
}));
jest.mock('stream/promises', () => ({
    pipeline: jest.fn()
}));

// Mock Services
jest.mock('../../../src/db', () => ({
    getCampaigns: jest.fn(),
    createCampaign: jest.fn(),
    createSession: jest.fn(),
    setSessionNumber: jest.fn(),
    getCampaignLocation: jest.fn(),
    addRecording: jest.fn(),
    getActiveCampaign: jest.fn(),
    getGuildConfig: jest.fn(),
    getUserProfile: jest.fn(),
    db: {
        prepare: jest.fn()
    }
}));
jest.mock('../../../src/monitor');
jest.mock('../../../src/services/queue', () => ({
    audioQueue: {
        add: jest.fn(),
    }
}));
jest.mock('../../../src/services/backup'); // uploadToOracle
jest.mock('../../../src/publisher');
jest.mock('../../../src/utils/discordHelper');

// Mock Fetch
global.fetch = jest.fn(() =>
    Promise.resolve({
        ok: true,
        headers: { get: () => 'audio/mpeg' },
        body: 'mock-stream'
    })
) as jest.Mock;

import * as db from '../../../src/db';
import * as fs from 'fs';
import * as queue from '../../../src/services/queue';

describe('TestStream Command E2E', () => {
    let clientMock: Client;
    let dispatcher: CommandDispatcher;
    let messageMock: Message;
    let replyMock: jest.Mock;

    let createdSessionId: string | null = null;
    let createdCampaignId: number | null = null;

    beforeEach(() => {
        jest.clearAllMocks();
        createdSessionId = null;
        createdCampaignId = null;

        // DB Mocks
        (db.getCampaigns as jest.Mock).mockReturnValue([]);
        (db.createCampaign as jest.Mock).mockImplementation((g, name) => {
            createdCampaignId = 99;
            return 99;
        });
        (db.createSession as jest.Mock).mockImplementation((id) => { createdSessionId = id; });
        (db.db.prepare as jest.Mock).mockReturnValue({ get: () => ({ maxnum: 5 }) }); // Mock session number query
        (db.setSessionNumber as jest.Mock).mockImplementation(() => { });
        (db.getCampaignLocation as jest.Mock).mockReturnValue({});
        (db.addRecording as jest.Mock).mockImplementation(() => { });
        (db.getActiveCampaign as jest.Mock).mockImplementation(() => {
            if (createdCampaignId) return { id: createdCampaignId, name: 'Campagna di Test', guild_id: 'guild-1' };
            return null;
        });
        (db.getGuildConfig as jest.Mock).mockReturnValue(null);

        // FS mocks
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        (fs.mkdirSync as jest.Mock).mockImplementation(() => { });

        // Setup Dispatcher
        clientMock = { user: { id: 'bot-id' } } as any;
        dispatcher = new CommandDispatcher(clientMock);
        dispatcher.register(debugCommand);

        // Setup Message Mock
        replyMock = jest.fn();
        messageMock = {
            author: { id: 'dev-1', bot: false },
            guild: { id: 'guild-1' },
            channelId: 'channel-1',
            channel: { send: jest.fn() },
            content: '',
            reply: replyMock,
        } as unknown as Message;
    });

    it('should create test campaign and session from URL', async () => {
        messageMock.content = '$debug teststream http://mock.url/file.mp3';

        // Ensure getCampaigns returns existing test campaign if we want to test that path,
        // OR return empty to test creation. Let's test creation first.
        (db.getCampaigns as jest.Mock).mockReturnValueOnce([]); // First call checks existing

        await dispatcher.dispatch(messageMock);

        // Verify Campaign Creation
        expect(db.createCampaign).toHaveBeenCalledWith('guild-1', 'Campagna di Test');

        // Verify Session Creation
        expect(db.createSession).toHaveBeenCalled();
        expect(createdSessionId).toContain('test-direct-');
        expect(db.setSessionNumber).toHaveBeenCalledWith(createdSessionId, 6); // 5 + 1

        // Verify Processing
        expect(queue.audioQueue.add).toHaveBeenCalled();
        expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Test Stream Avviato'));
        expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('accodato'));
    });

    it('should reuse existing test campaign', async () => {
        messageMock.content = '$debug teststream http://mock.url/file.mp3';

        const testCamp = { id: 123, name: 'Campagna di Test', guild_id: 'guild-1' };
        (db.getCampaigns as jest.Mock).mockReturnValue([testCamp]);

        await dispatcher.dispatch(messageMock);

        expect(db.createCampaign).not.toHaveBeenCalled();
        expect(createdSessionId).toBeDefined();
    });
});
