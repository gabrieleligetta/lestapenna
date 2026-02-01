
import { cronacaCommand } from '../../../src/commands/characters/../sessions/cronaca';
import { CommandContext } from '../../../src/commands/types';
import { guildSessions } from '../../../src/state/sessionState';

// Mock DB and Repositories
jest.mock('../../../src/db', () => ({
    getAvailableSessions: jest.fn().mockReturnValue([
        { session_id: 'sess-1', start_time: Date.now(), title: 'Test Session', fragments: 10 }
    ]),
    getSessionAIOutput: jest.fn().mockReturnValue({
        summaryData: { narrativeBrief: 'This is a test summary.' }
    }),
    addSessionNote: jest.fn(),
    setSessionNumber: jest.fn(),
    db: {
        prepare: jest.fn(),
        run: jest.fn()
    },
    factionRepository: {
        getPartyFaction: jest.fn()
    },
    getUserProfile: jest.fn()
}));

// Mock Commands to avoid side effects like Redis
jest.mock('../../../src/commands/sessions/stop', () => ({
    stopCommand: { execute: jest.fn() }
}));
jest.mock('../../../src/commands/sessions/listen', () => ({
    listenCommand: { execute: jest.fn() }
}));

import * as db from '../../../src/db';

describe('Session Dashboard (Unified $session)', () => {
    let mockContext: CommandContext;
    let replyMock: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        guildSessions.clear();
        replyMock = jest.fn().mockResolvedValue({
            createMessageComponentCollector: jest.fn().mockReturnValue({
                on: jest.fn(),
                stop: jest.fn()
            })
        });

        mockContext = {
            message: {
                reply: replyMock,
                author: { id: 'user-123' },
            } as any,
            args: [],
            guildId: 'guild-456',
            activeCampaign: { id: 1, name: 'Test Campaign' } as any,
            client: {} as any,
        };
    });

    it('should show active session dashboard when a session is running', async () => {
        guildSessions.set('guild-456', 'active-sess-id');

        await cronacaCommand.execute(mockContext);

        expect(replyMock).toHaveBeenCalledWith(expect.objectContaining({
            embeds: [expect.objectContaining({
                data: expect.objectContaining({ title: '🎙️ Sessione in Corso' })
            })],
            components: expect.any(Array)
        }));
    });

    it('should show archive dashboard when no session is running', async () => {
        await cronacaCommand.execute(mockContext);

        expect(replyMock).toHaveBeenCalledWith(expect.objectContaining({
            embeds: [expect.objectContaining({
                data: expect.objectContaining({ title: '📜 Archivio Cronache' })
            })],
            components: expect.any(Array)
        }));
    });
});
