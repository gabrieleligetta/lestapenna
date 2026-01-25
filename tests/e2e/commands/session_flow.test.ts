
import { CommandDispatcher } from '../../../src/commands/index';
import { Client, Message, Collection } from 'discord.js';
import { listenCommand } from '../../../src/commands/sessions/listen';
import { stopCommand } from '../../../src/commands/sessions/stop';
import { noteCommand } from '../../../src/commands/sessions/note';
import { pauseCommand } from '../../../src/commands/sessions/pause';

// Global State Mock
jest.mock('../../../src/index', () => ({
    guildSessions: new Map(),
    checkAutoLeave: jest.fn()
}));

// @ts-ignore
import { guildSessions } from '../../../src/index';
const mockGuildSessions = guildSessions as Map<string, string>;

// Mock Modules
jest.mock('../../../src/db');
jest.mock('../../../src/monitor');
jest.mock('../../../src/services/queue', () => ({
    audioQueue: {
        pause: jest.fn(),
        resume: jest.fn()
    }
}));
jest.mock('../../../src/services/recorder');
jest.mock('../../../src/publisher');
jest.mock('../../../src/services/SessionPhaseManager', () => ({
    sessionPhaseManager: { setPhase: jest.fn() }
}));

import * as db from '../../../src/db';
import * as recorder from '../../../src/services/recorder';

describe('Session E2E Flow', () => {
    let clientMock: Client;
    let dispatcher: CommandDispatcher;
    let messageMock: Message;
    let replyMock: jest.Mock;
    let spyOnExecute: jest.SpyInstance;

    // DB State
    let activeSessionId: string | null = null;

    beforeEach(() => {
        jest.clearAllMocks();
        mockGuildSessions.clear();
        activeSessionId = null;

        // Clear Env
        process.env.DISCORD_COMMAND_AND_RESPONSE_CHANNEL_ID = '';

        // DB Mocks
        (db.getActiveCampaign as jest.Mock).mockReturnValue({ id: 1, name: 'Campaign 1', current_year: 100 });
        (db.getGuildConfig as jest.Mock).mockReturnValue(null);
        (db.getUserProfile as jest.Mock).mockReturnValue({ character_name: 'Hero' });
        (db.createSession as jest.Mock).mockImplementation((id) => { activeSessionId = id; });
        (db.addSessionNote as jest.Mock).mockImplementation(() => { });

        // Setup Dispatcher
        clientMock = { user: { id: 'bot-id' } } as any;
        dispatcher = new CommandDispatcher(clientMock);

        dispatcher.register(listenCommand);
        dispatcher.register(stopCommand);
        dispatcher.register(noteCommand);
        dispatcher.register(pauseCommand);

        // Setup Message Mock
        replyMock = jest.fn();
        messageMock = {
            author: { id: 'user-1', bot: false },
            guild: { id: 'guild-1' },
            channelId: 'channel-1',
            channel: { send: jest.fn() },
            content: '',
            reply: replyMock,
            member: {
                voice: {
                    channel: {
                        id: 'vc-1',
                        members: new Collection()
                    }
                },
                displayName: 'Hero'
            }
        } as unknown as Message;

        spyOnExecute = jest.spyOn(listenCommand, 'execute');

        // Add member to voice
        (messageMock.member!.voice.channel!.members as Collection<any, any>).set('user-1', { user: { bot: false }, displayName: 'Hero', id: 'user-1' });
    });

    it('should handle full session lifecycle', async () => {
        // 1. Start Session
        messageMock.content = '$ascolta';
        await dispatcher.dispatch(messageMock);

        if ((recorder.connectToChannel as jest.Mock).mock.calls.length === 0) {
            console.log('Listen Failed. Reply calls:', replyMock.mock.calls);
            console.log('Execute called:', spyOnExecute.mock.calls.length);
        }
        expect(recorder.connectToChannel).toHaveBeenCalled();
        expect(mockGuildSessions.has('guild-1')).toBe(true);
        expect(activeSessionId).toBeDefined();

        // 2. Add Note
        messageMock.content = '$nota Found a dragon';
        await dispatcher.dispatch(messageMock);

        expect(db.addSessionNote).toHaveBeenCalledWith(activeSessionId, 'user-1', 'Found a dragon', expect.any(Number));

        // 3. Pause
        (recorder.isRecordingPaused as jest.Mock).mockReturnValue(false);
        messageMock.content = '$pausa';
        await dispatcher.dispatch(messageMock);

        expect(recorder.pauseRecording).toHaveBeenCalled();

        // 4. Resume
        (recorder.isRecordingPaused as jest.Mock).mockReturnValue(true);
        messageMock.content = '$riprendi';
        await dispatcher.dispatch(messageMock);

        expect(recorder.resumeRecording).toHaveBeenCalled();

        // 5. Stop Session
        messageMock.content = '$stop';
        await dispatcher.dispatch(messageMock);

        expect(recorder.disconnect).toHaveBeenCalled();
        expect(mockGuildSessions.has('guild-1')).toBe(false);
    });
});
