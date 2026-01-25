
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
import { Readable } from 'stream';
global.fetch = jest.fn(() =>
    Promise.resolve({
        ok: true,
        headers: { get: () => 'audio/mpeg' },
        body: Readable.from(['mock-stream'])
    })
) as jest.Mock;

import * as fs from 'fs';

describe('TestStream Command E2E', () => {
    let clientMock: Client;
    let dispatcher: CommandDispatcher;
    let messageMock: Message;
    let replyMock: jest.Mock;
    let mockDbInstance: any;

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
        // 1. Verify Campaign Creation (via mock calls)
        const campaignCalls = mockDbInstance.prepare.mock.calls.filter((c: any[]) => c[0].includes('INSERT INTO campaigns'));
        expect(campaignCalls.length).toBeGreaterThan(0);

        // 2. Verify Session Creation
        const sessionCalls = mockDbInstance.prepare.mock.calls.filter((c: any[]) => c[0].includes('INSERT INTO sessions'));
        expect(sessionCalls.length).toBeGreaterThan(0);

        // 3. Verify NO 'INSERT INTO characters' was called (System design confirmation)
        const charCalls = mockDbInstance.prepare.mock.calls.filter((c: any[]) => c[0].includes('INSERT INTO characters'));
        expect(charCalls.length).toBe(0);
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
