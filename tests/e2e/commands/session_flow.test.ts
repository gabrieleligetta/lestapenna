
import { CommandDispatcher } from '../../../src/commands/index';
import { Client, Message, Collection } from 'discord.js';
import { listenCommand } from '../../../src/commands/sessions/listen';
import { stopCommand } from '../../../src/commands/sessions/stop';
import { pauseCommand } from '../../../src/commands/sessions/pause';

// Mock sessionState — commands use async setActiveSession/getActiveSession/deleteActiveSession
jest.mock('../../../src/state/sessionState', () => {
    const map = new Map<string, string>();
    return {
        guildSessions: map,
        getActiveSession: jest.fn().mockImplementation((id: string) => Promise.resolve(map.get(id))),
        hasActiveSession: jest.fn().mockImplementation((id: string) => Promise.resolve(map.has(id))),
        setActiveSession: jest.fn().mockImplementation((id: string, s: string) => { map.set(id, s); return Promise.resolve(); }),
        deleteActiveSession: jest.fn().mockImplementation((id: string) => { map.delete(id); return Promise.resolve(); }),
        autoLeaveTimers: new Map(),
        incrementRecordingCount: jest.fn().mockResolvedValue(undefined),
        decrementRecordingCount: jest.fn().mockResolvedValue(undefined),
        acquireRecordingCapacity: jest.fn().mockResolvedValue({ acquired: true, active: 1, limit: 2, pendingForGuild: 0 }),
        releaseRecordingCapacity: jest.fn().mockResolvedValue(undefined),
        getRecordingCapacityLimit: jest.fn().mockReturnValue(2),
        resetRecordingState: jest.fn().mockResolvedValue(undefined),
    };
});

// @ts-ignore — guildSessions is injected via mock above
import { guildSessions } from '../../../src/state/sessionState';
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
jest.mock('../../../src/services/sessionProcessing', () => ({
    launchSessionProcessing: jest.fn(),
}));
jest.mock('../../../src/services/SessionPhaseManager', () => ({
    sessionPhaseManager: { setPhase: jest.fn() }
}));
jest.mock('../../../src/commands/sessions/testEnv', () => ({
    ensureTestEnvironment: jest.fn(),
}));
jest.mock('../../../src/commands/utils/worldConfig', () => ({
    startWorldConfigurationFlow: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../src/commands/sessions/listenInteractive', () => ({
    startInteractiveLocationSelection: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../src/bootstrap/voiceState', () => ({
    checkAutoLeave: jest.fn(),
}));
jest.mock('../../../src/commands/utils/campaignWrite', () => ({
    assertCampaignWrite: jest.fn().mockResolvedValue(true),
}));
// The test table has its own keys: what is verified here is the session's
// lifecycle, not the BYOK gate — that has its own dedicated cases.
jest.mock('../../../src/commands/utils/aiConfigured', () => ({
    assertAiConfigured: jest.fn().mockResolvedValue(true),
}));
// This test's fake guild has no `members.me`, so the `[REC]` marker
// could not be set and the session would refuse to start —
// which is exactly the intended behaviour, and has its own dedicated tests.
jest.mock('../../../src/services/recordingNotice', () => ({
    markRecording: jest.fn().mockResolvedValue(true),
    clearRecording: jest.fn().mockResolvedValue(undefined),
    announceRecording: jest.fn().mockResolvedValue(undefined),
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
        (db.getGuildConfig as jest.Mock).mockReturnValue('channel-1');
        (db.getUserProfile as jest.Mock).mockReturnValue({ character_name: 'Hero' });
        (db.createSession as jest.Mock).mockImplementation((id) => { activeSessionId = id; });
        (db.addSessionNote as jest.Mock).mockImplementation(() => { });
        // World config guards in listen command
        (db.getCampaignLocation as jest.Mock).mockReturnValue({ macro: 'Forgotten Realms', micro: 'Phandalin' });
        (db.factionRepository as any) = {
            getPartyFaction: jest.fn().mockReturnValue({ id: 1, name: 'Gli Avventurieri' }),
            createPartyFaction: jest.fn().mockReturnValue({ id: 1, name: 'Gli Avventurieri' }),
            ensurePartyMembership: jest.fn(),
        };

        // Setup Dispatcher
        clientMock = { user: { id: 'bot-id' } } as any;
        dispatcher = new CommandDispatcher(clientMock);

        dispatcher.register(listenCommand);
        dispatcher.register(stopCommand);
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
