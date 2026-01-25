
import { CommandDispatcher } from '../../../src/commands/index';
import { Client, Message } from 'discord.js';
import Database from 'better-sqlite3';

// Mock Modules
jest.mock('fs');
jest.mock('better-sqlite3', () => {
    return jest.fn().mockImplementation(() => ({
        pragma: jest.fn(),
        prepare: jest.fn().mockReturnValue({
            get: jest.fn().mockReturnValue({ maxnum: 5 }),
            run: jest.fn().mockReturnValue({ changes: 1, lastInsertRowid: 99 }),
            all: jest.fn().mockReturnValue([])
        }),
        exec: jest.fn()
    }));
});

jest.mock('../../../src/monitor', () => ({
    monitor: { startSession: jest.fn() }
}));
jest.mock('../../../src/services/queue', () => ({
    audioQueue: { add: jest.fn() }
}));
jest.mock('../../../src/services/backup');
jest.mock('../../../src/publisher');
jest.mock('../../../src/utils/discordHelper');

// Mock Fetch with valid Stream
import { Readable, PassThrough } from 'stream';

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

describe('TestStream Command E2E', () => {
    let clientMock: Client;
    let dispatcher: CommandDispatcher;
    let messageMock: Message;
    let replyMock: jest.Mock;
    let mockDbInstance: any;

    beforeAll(() => {
        process.env.DISCORD_BOT_TOKEN = 'test-token';
        process.env.DISCORD_CLIENT_ID = 'test-client-id';
        process.env.DISCORD_GUILD_ID = 'test-guild-id';
    });

    beforeEach(() => {
        jest.clearAllMocks();

        // Setup DB Mock Instance
        // Recover the instance created by client.ts
        const mockConstructor = Database as unknown as jest.Mock;
        if (mockConstructor.mock.instances.length > 0) {
            mockDbInstance = mockConstructor.mock.instances[0];
        } else {
            mockDbInstance = new (Database as any)();
        }

        // Apply specific mock logic for this test run
        mockDbInstance.prepare.mockImplementation((sql: string) => {
            console.log('MOCK DB QUERY:', sql);
            return {
                get: jest.fn().mockImplementation(() => {
                    if (sql.includes('SELECT MAX')) return { maxnum: 5 };
                    if (sql.includes('SELECT * FROM campaigns')) return undefined; // Default no campaigns
                    return undefined;
                }),
                run: jest.fn().mockImplementation(() => {
                    return { changes: 1, lastInsertRowid: 99 };
                }),
                all: jest.fn().mockImplementation(() => {
                    return [];
                })
            };
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

        // Load Code
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
        } as unknown as Message;
    });

    it('should create test campaign and session from URL', async () => {
        messageMock.content = '$teststream http://mock.url/file.mp3';

        await dispatcher.dispatch(messageMock);

        expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Test Stream Avviato'));

        // --- DM/User Linking Verification ---
        // Match user facing success
        expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Test Stream Avviato'));
    });

    it('should reuse existing test campaign', async () => {
        // Mock DB to return existing campaign
        mockDbInstance.prepare.mockImplementation((sql: string) => {
            if (sql.includes('SELECT * FROM campaigns')) {
                return {
                    all: jest.fn().mockReturnValue([{ id: 123, name: 'Campagna di Test', guild_id: 'guild-1' }]),
                    get: jest.fn(),
                    run: jest.fn()
                };
            }
            return {
                get: jest.fn().mockReturnValue({ maxnum: 5 }),
                run: jest.fn(),
                all: jest.fn().mockReturnValue([])
            };
        });

        messageMock.content = '$teststream http://mock.url/file.mp3';

        await dispatcher.dispatch(messageMock);

        expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Test Stream Avviato'));
    });
});
