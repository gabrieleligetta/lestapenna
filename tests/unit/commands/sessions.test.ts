
import { listenCommand } from '../../../src/commands/sessions/listen';
import { stopCommand } from '../../../src/commands/sessions/stop';
import { pauseCommand } from '../../../src/commands/sessions/pause';
import { noteCommand } from '../../../src/commands/sessions/note';
import { listCommand } from '../../../src/commands/sessions/list';
import { CommandContext } from '../../../src/commands/types';
import { EmbedBuilder, Collection } from 'discord.js';

// Mock Modules
jest.mock('../../../src/db');
jest.mock('../../../src/monitor');
jest.mock('../../../src/services/queue', () => ({
    audioQueue: {
        add: jest.fn(),
        pause: jest.fn(),
        resume: jest.fn(),
        getJob: jest.fn()
    }
}));
jest.mock('../../../src/services/recorder');
jest.mock('../../../src/publisher');
jest.mock('../../../src/services/SessionPhaseManager', () => ({
    sessionPhaseManager: { setPhase: jest.fn() }
}));

jest.mock('../../../src/state/sessionState', () => ({
    guildSessions: new Map(),
    autoLeaveTimers: new Map(),
}));

jest.mock('../../../src/bootstrap/voiceState', () => ({
    checkAutoLeave: jest.fn()
}));

// @ts-ignore
import { guildSessions } from '../../../src/state/sessionState';
const mockGuildSessions = guildSessions as Map<string, string>;

import * as db from '../../../src/db';
import * as recorder from '../../../src/services/recorder';
import * as queue from '../../../src/services/queue';
import * as publisher from '../../../src/publisher';

describe('Session Commands', () => {
    let mockContext: CommandContext;
    let replyMock: jest.Mock;
    let sendMock: jest.Mock;
    let memberMock: any;

    beforeEach(() => {
        jest.clearAllMocks();
        mockGuildSessions.clear();

        replyMock = jest.fn();
        sendMock = jest.fn();

        memberMock = {
            id: 'user-1',
            displayName: 'User',
            voice: {
                channel: {
                    id: 'vc-1',
                    members: new Collection(),
                    guild: { id: 'guild-1' }
                }
            }
        };
        // Add self to voice members
        (memberMock.voice.channel.members as Collection<any, any>).set('user-1', { user: { bot: false }, displayName: 'User', id: 'user-1' });

        mockContext = {
            message: {
                reply: replyMock,
                author: { id: 'user-1' },
                member: memberMock,
                guild: { id: 'guild-1' },
                channel: { send: sendMock },
                content: '$listen'
            } as any,
            args: [],
            guildId: 'guild-1',
            activeCampaign: { id: 1, name: 'Test Campaign', current_year: 100 } as any,
            client: {} as any,
        };
    });

    describe('Listen Command', () => {
        it('should start listening if context is valid', async () => {
            (db.getActiveCampaign as jest.Mock).mockReturnValue(mockContext.activeCampaign);
            (db.getUserProfile as jest.Mock).mockReturnValue({ character_name: 'Hero' });

            await listenCommand.execute(mockContext);

            expect(recorder.connectToChannel).toHaveBeenCalled();
            expect(queue.audioQueue.pause).toHaveBeenCalled();
            expect(db.createSession).toHaveBeenCalled();
            expect(mockGuildSessions.has('guild-1')).toBe(true);
            expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Cronaca Iniziata'));
        });

        it('should block if campaign year is missing', async () => {
            mockContext.activeCampaign!.current_year = undefined as any;
            await listenCommand.execute(mockContext);
            expect(recorder.connectToChannel).not.toHaveBeenCalled();
            expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Configurazione Temporale Mancante'));
        });

        it('should block if user not in voice', async () => {
            (mockContext.message.member as any).voice.channel = null;
            await listenCommand.execute(mockContext);
            expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Devi essere in un canale vocale'));
        });
    });

    describe('Stop Command', () => {
        it('should stop session and trigger summary', async () => {
            mockGuildSessions.set('guild-1', 'session-123');

            await stopCommand.execute(mockContext);

            expect(recorder.disconnect).toHaveBeenCalledWith('guild-1');
            expect(mockGuildSessions.has('guild-1')).toBe(false);
            expect(queue.audioQueue.resume).toHaveBeenCalled();
            expect(publisher.waitForCompletionAndSummarize).toHaveBeenCalled();
            expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('terminata'));
        });

        it('should handle stop when no session active', async () => {
            await stopCommand.execute(mockContext);
            expect(recorder.disconnect).toHaveBeenCalled(); // Should disconnect anyway
            expect(publisher.waitForCompletionAndSummarize).not.toHaveBeenCalled();
            expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Nessuna sessione attiva'));
        });
    });

    describe('Pause/Resume Command', () => {
        it('should pause if active and running', async () => {
            mockContext.message.content = '$pausa';
            mockGuildSessions.set('guild-1', 'session-123');
            (recorder.isRecordingPaused as jest.Mock).mockReturnValue(false);

            await pauseCommand.execute(mockContext);

            expect(recorder.pauseRecording).toHaveBeenCalledWith('guild-1');
            expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('in Pausa'));
        });

        it('should resume if active and paused', async () => {
            mockContext.message.content = '$riprendi';
            mockGuildSessions.set('guild-1', 'session-123');
            (recorder.isRecordingPaused as jest.Mock).mockReturnValue(true);

            await pauseCommand.execute(mockContext);

            expect(recorder.resumeRecording).toHaveBeenCalledWith('guild-1');
            expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Ripresa'));
        });
    });

    describe('Note Command', () => {
        it('should add note if session active', async () => {
            mockGuildSessions.set('guild-1', 'session-123');
            mockContext.args = ['Test', 'Note'];

            await noteCommand.execute(mockContext);

            expect(db.addSessionNote).toHaveBeenCalledWith('session-123', 'user-1', 'Test Note', expect.any(Number));
            expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Nota aggiunta'));
        });

        it('should block note if no session active', async () => {
            await noteCommand.execute(mockContext);
            expect(db.addSessionNote).not.toHaveBeenCalled();
            expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Nessuna sessione attiva'));
        });
    });

    describe('List Sessions', () => {
        it('should list sessions', async () => {
            (db.getAvailableSessions as jest.Mock).mockReturnValue([
                { session_id: 's1', start_time: Date.now(), title: 'Session 1', fragments: 10 }
            ]);

            // Mock collector
            replyMock.mockResolvedValue({ createMessageComponentCollector: jest.fn() });

            await listCommand.execute(mockContext);

            expect(replyMock).toHaveBeenCalled();
            const embed = (replyMock.mock.calls[0][0] as any).embeds[0] as EmbedBuilder;
            expect(embed.data.description).toContain('Session 1');
        });

        it('should handle empty sessions list', async () => {
            (db.getAvailableSessions as jest.Mock).mockReturnValue([]);
            await listCommand.execute(mockContext);
            expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Nessuna sessione trovata'));
        });
    });
});
