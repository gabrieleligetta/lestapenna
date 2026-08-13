/**
 * Boundary tests for the 10h technical session cap: it is the only reason a
 * running recording is ever stopped automatically. It protects disk and the
 * user's own provider bill from a voice channel left open, and has nothing to
 * do with plans or quotas — those no longer exist.
 */

const disconnectMock = jest.fn().mockResolvedValue(true);
jest.mock('../../../src/services/recorder', () => ({
    disconnect: disconnectMock,
}));

const getActiveSessionMock = jest.fn();
const deleteActiveSessionMock = jest.fn().mockResolvedValue(undefined);
const decrementRecordingCountMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../src/state/sessionState', () => ({
    getActiveSession: (...args: unknown[]) => getActiveSessionMock(...args),
    deleteActiveSession: (...args: unknown[]) => deleteActiveSessionMock(...args),
    decrementRecordingCount: (...args: unknown[]) => decrementRecordingCountMock(...args),
}));

const getGuildConfigMock = jest.fn().mockReturnValue(undefined);
jest.mock('../../../src/db', () => ({
    getGuildConfig: (...args: unknown[]) => getGuildConfigMock(...args),
}));

const launchSessionProcessingMock = jest.fn();
jest.mock('../../../src/services/sessionProcessing', () => ({
    launchSessionProcessing: (...args: unknown[]) => launchSessionProcessingMock(...args),
}));

import {
    SESSION_HARD_CAP_MINUTES,
    scheduleSessionHardCap,
    clearSessionHardCap,
} from '../../../src/services/sessionHardCap';

const fakeClient = { channels: { fetch: jest.fn() } } as any;

describe('Session hard cap (10h technical safety stop)', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        getActiveSessionMock.mockResolvedValue(undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('is calibrated to 10 hours', () => {
        expect(SESSION_HARD_CAP_MINUTES).toBe(600);
    });

    it('never fires before the 10h cap is reached', async () => {
        getActiveSessionMock.mockResolvedValue('sess-1');
        scheduleSessionHardCap('guild-1', 'sess-1', fakeClient);

        // Advance to just under the cap — must not have stopped anything yet
        await jest.advanceTimersByTimeAsync(SESSION_HARD_CAP_MINUTES * 60 * 1000 - 1000);

        expect(disconnectMock).not.toHaveBeenCalled();
        expect(launchSessionProcessingMock).not.toHaveBeenCalled();
    });

    it('stops the session automatically once the 10h cap is reached', async () => {
        getActiveSessionMock.mockResolvedValue('sess-1');
        scheduleSessionHardCap('guild-1', 'sess-1', fakeClient);

        await jest.advanceTimersByTimeAsync(SESSION_HARD_CAP_MINUTES * 60 * 1000);

        expect(deleteActiveSessionMock).toHaveBeenCalledWith('guild-1');
        expect(disconnectMock).toHaveBeenCalledWith('guild-1', { processSession: false });
        expect(launchSessionProcessingMock).toHaveBeenCalledWith('sess-1', 'guild-1');
    });

    it('does not act if the session already ended by other means (stop/auto-leave)', async () => {
        // Session was replaced/ended before the timer fired
        getActiveSessionMock.mockResolvedValue(undefined);
        scheduleSessionHardCap('guild-2', 'sess-2', fakeClient);

        await jest.advanceTimersByTimeAsync(SESSION_HARD_CAP_MINUTES * 60 * 1000);

        expect(disconnectMock).not.toHaveBeenCalled();
        expect(launchSessionProcessingMock).not.toHaveBeenCalled();
    });

    it('clearSessionHardCap cancels a pending timer', async () => {
        getActiveSessionMock.mockResolvedValue('sess-3');
        scheduleSessionHardCap('guild-3', 'sess-3', fakeClient);
        clearSessionHardCap('guild-3');

        await jest.advanceTimersByTimeAsync(SESSION_HARD_CAP_MINUTES * 60 * 1000);

        expect(disconnectMock).not.toHaveBeenCalled();
    });
});
