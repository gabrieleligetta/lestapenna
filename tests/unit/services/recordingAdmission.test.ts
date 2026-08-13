const processingJobs = jest.fn().mockResolvedValue([]);
const finalizationJobs = jest.fn().mockResolvedValue([]);

jest.mock('../../../src/services/queue', () => ({
    sessionProcessingQueue: { getJobs: (...args: unknown[]) => processingJobs(...args) },
    sessionFinalizationQueue: { getJobs: (...args: unknown[]) => finalizationJobs(...args) },
}));

jest.mock('ioredis', () => ({
    __esModule: true,
    default: class RedisMock {
        connect() { return Promise.resolve(); }
        get() { return Promise.resolve(null); }
        set() { return Promise.resolve(); }
        del() { return Promise.resolve(); }
        exists() { return Promise.resolve(0); }
        srem() { return Promise.resolve(0); }
        scard() { return Promise.resolve(0); }
        hdel() { return Promise.resolve(0); }
        hlen() { return Promise.resolve(0); }
        hvals() { return Promise.resolve([]); }
    },
}));

describe('recording admission on a free instance', () => {
    let state: typeof import('../../../src/state/sessionState');
    const oldDisabled = process.env.DISABLE_REDIS;

    beforeAll(() => {
        process.env.DISABLE_REDIS = 'true';
        state = require('../../../src/state/sessionState');
    });

    beforeEach(async () => {
        processingJobs.mockResolvedValue([]);
        finalizationJobs.mockResolvedValue([]);
        await state.resetRecordingState();
    });

    afterAll(() => {
        process.env.DISABLE_REDIS = oldDisabled;
    });

    it('admits two guilds, refuses the third, and recovers the released slot', async () => {
        await expect(state.acquireRecordingCapacity('guild-1')).resolves.toMatchObject({ acquired: true });
        await expect(state.acquireRecordingCapacity('guild-2')).resolves.toMatchObject({ acquired: true });
        await expect(state.acquireRecordingCapacity('guild-3')).resolves.toMatchObject({
            acquired: false,
            reason: 'recording_capacity',
            active: 2,
            limit: 2,
        });

        await state.releaseRecordingCapacity('guild-1');
        await expect(state.acquireRecordingCapacity('guild-3')).resolves.toMatchObject({ acquired: true });
    });

    it('does not let one guild build an unbounded processing backlog', async () => {
        processingJobs.mockResolvedValue([
            { data: { guildId: 'guild-1', sessionId: 'session-a' } },
            { data: { guildId: 'guild-1', sessionId: 'session-b' } },
        ]);

        await expect(state.acquireRecordingCapacity('guild-1')).resolves.toMatchObject({
            acquired: false,
            reason: 'guild_backlog',
            pendingForGuild: 2,
        });
    });

});
