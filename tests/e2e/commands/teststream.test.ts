
import { CommandDispatcher } from '../../../src/commands/index';
import { Client, Message } from 'discord.js';
import { Readable, PassThrough } from 'stream';

// Mock better-sqlite3 to prevent real SQLite connections from direct repository imports
jest.mock('better-sqlite3', () => {
    return jest.fn().mockImplementation(() => ({
        pragma: jest.fn(),
        prepare: jest.fn().mockReturnValue({
            get: jest.fn().mockReturnValue(undefined),
            run: jest.fn().mockReturnValue({ changes: 1, lastInsertRowid: 99 }),
            all: jest.fn().mockReturnValue([]),
        }),
        exec: jest.fn(),
        transaction: jest.fn().mockImplementation((fn: Function) => (...args: any[]) => fn(...args)),
    }));
});

// Mock FS — preserve readFileSync so loadAiConfig() works
jest.mock('fs', () => {
    const actual = jest.requireActual<typeof import('fs')>('fs');
    return {
        ...actual,
        existsSync: jest.fn(),
        mkdirSync: jest.fn(),
        createWriteStream: jest.fn(),
        writeFileSync: jest.fn(),
        readFile: jest.fn(),
    };
});

// Mock ensureTestEnvironment to bypass DB-heavy campaign setup
jest.mock('../../../src/commands/sessions/testEnv', () => ({
    ensureTestEnvironment: jest.fn().mockResolvedValue({ id: 1, name: 'Campagna di Test', guild_id: 'guild-1' }),
}));

// Mock DB at function level
jest.mock('../../../src/db', () => ({
    getActiveCampaign: jest.fn().mockReturnValue(null),
    getGuildConfig: jest.fn().mockReturnValue('channel-1'),
    getCampaigns: jest.fn().mockReturnValue([]),
    createCampaign: jest.fn(),
    setActiveCampaign: jest.fn(),
    createSession: jest.fn(),
    setSessionNumber: jest.fn(),
    getCampaignLocation: jest.fn().mockReturnValue(null),
    addRecording: jest.fn().mockReturnValue(1),
    updateRecordingStatus: jest.fn(),
    getUserProfile: jest.fn().mockReturnValue({ character_name: 'Hero' }),
    updateUserCharacter: jest.fn(),
    setCampaignYear: jest.fn(),
    updateLocation: jest.fn(),
    db: {
        prepare: jest.fn().mockReturnValue({
            get: jest.fn().mockReturnValue({ maxnum: 5 }),
            run: jest.fn().mockReturnValue({ changes: 1, lastInsertRowid: 99 }),
            all: jest.fn().mockReturnValue([]),
        }),
    },
    factionRepository: {
        getPartyFaction: jest.fn().mockReturnValue(null),
        createPartyFaction: jest.fn().mockReturnValue(null),
        ensurePartyMembership: jest.fn(),
    },
}));

jest.mock('../../../src/monitor', () => ({
    monitor: { startSession: jest.fn() }
}));
jest.mock('../../../src/services/queue', () => ({
    audioQueue: { add: jest.fn() }
}));
jest.mock('../../../src/services/backup');
jest.mock('../../../src/publisher');
jest.mock('../../../src/utils/discordHelper');

// Mock Fetch
global.fetch = jest.fn(() => {
    const stream = new Readable();
    stream.push('mock-stream');
    stream.push(null);

    return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'audio/mpeg' },
        body: stream,
        arrayBuffer: () => Promise.resolve(Buffer.from('mock-stream'))
    });
}) as jest.Mock;

import * as fs from 'fs';
import * as db from '../../../src/db';

describe('TestStream Command E2E', () => {
    let clientMock: Client;
    let dispatcher: CommandDispatcher;
    let messageMock: Message;
    let replyMock: jest.Mock;

    beforeAll(() => {
        process.env.DISCORD_BOT_TOKEN = 'test-token';
        process.env.DISCORD_CLIENT_ID = 'test-client-id';
        process.env.DISCORD_GUILD_ID = 'test-guild-id';
    });

    beforeEach(() => {
        jest.clearAllMocks();

        // Restore defaults after clearAllMocks
        (db.getActiveCampaign as jest.Mock).mockReturnValue(null);
        (db.getGuildConfig as jest.Mock).mockReturnValue('channel-1');
        (db.getCampaigns as jest.Mock).mockReturnValue([]);
        (db.createSession as jest.Mock).mockReturnValue(undefined);
        (db.addRecording as jest.Mock).mockReturnValue(1);
        (db.db.prepare as jest.Mock).mockReturnValue({
            get: jest.fn().mockReturnValue({ maxnum: 5 }),
            run: jest.fn().mockReturnValue({ changes: 1, lastInsertRowid: 99 }),
            all: jest.fn().mockReturnValue([]),
        });

        // Clear Env
        delete process.env.DISCORD_COMMAND_AND_RESPONSE_CHANNEL_ID;

        // FS mocks
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        (fs.mkdirSync as jest.Mock).mockImplementation(() => { });
        (fs.createWriteStream as jest.Mock).mockImplementation(() => new PassThrough());

        // Setup Dispatcher
        clientMock = { user: { id: 'bot-id' } } as any;
        dispatcher = new CommandDispatcher(clientMock);

        const { debugCommand } = require('../../../src/commands/admin/debug');
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
            // $teststream passa da debugCommand, ora operatorOnly.
            member: { permissions: { has: () => true } },
        } as unknown as Message;
    });

    it('should create test campaign and session from URL', async () => {
        messageMock.content = '$teststream https://audio.example.test/file.mp3';

        await dispatcher.dispatch(messageMock);

        expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Test Stream Started'));
    });

    it('should reuse existing test campaign', async () => {
        // Mock ensureTestEnvironment to return existing campaign
        const { ensureTestEnvironment } = require('../../../src/commands/sessions/testEnv');
        (ensureTestEnvironment as jest.Mock).mockResolvedValue({ id: 123, name: 'Campagna di Test', guild_id: 'guild-1' });

        messageMock.content = '$teststream https://audio.example.test/file.mp3';

        await dispatcher.dispatch(messageMock);

        expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Test Stream Started'));
    });
});
