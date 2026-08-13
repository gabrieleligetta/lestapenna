const sessionProcessingAdd = jest.fn().mockResolvedValue({ id: 'session-job' });
const finalizationAdd = jest.fn().mockResolvedValue({ id: 'final-job' });
const audioAdd = jest.fn().mockResolvedValue({ id: 'audio-job' });
const sessionProcessingGetJob = jest.fn().mockResolvedValue(undefined);
const finalizationGetJob = jest.fn().mockResolvedValue(undefined);

jest.mock('../../../src/services/queue', () => ({
    sessionProcessingQueue: {
        add: (...args: unknown[]) => sessionProcessingAdd(...args),
        getJob: (...args: unknown[]) => sessionProcessingGetJob(...args),
    },
    sessionFinalizationQueue: {
        add: (...args: unknown[]) => finalizationAdd(...args),
        getJob: (...args: unknown[]) => finalizationGetJob(...args),
    },
    audioQueue: { add: (...args: unknown[]) => audioAdd(...args) },
}));

const getSessionRecordings = jest.fn();
jest.mock('../../../src/db', () => ({
    getSessionRecordings: (...args: unknown[]) => getSessionRecordings(...args),
}));

const mixSessionAudio = jest.fn().mockResolvedValue('/tmp/master.mp3');
jest.mock('../../../src/services/sessionMixer', () => ({
    mixSessionAudio: (...args: unknown[]) => mixSessionAudio(...args),
}));

const startSession = jest.fn();
const snapshotSession = jest.fn().mockReturnValue({
    sessionId: 'session-1', startTime: 1, totalFiles: 1,
    totalAudioDurationSec: 60, transcriptionTimeMs: 10,
    summarizationTimeMs: 0, totalTokensUsed: 0, errors: [],
    resourceUsage: { cpuSamples: [], ramSamplesMB: [] },
});
const discardSession = jest.fn();
jest.mock('../../../src/monitor', () => ({
    monitor: {
        startSession: (...args: unknown[]) => startSession(...args),
        setRuntimePhase: jest.fn(),
        snapshotSession: (...args: unknown[]) => snapshotSession(...args),
        discardSession: (...args: unknown[]) => discardSession(...args),
        endSession: jest.fn(),
    },
}));

const markFailed = jest.fn();
jest.mock('../../../src/services/SessionPhaseManager', () => ({
    sessionPhaseManager: { markFailed: (...args: unknown[]) => markFailed(...args) },
}));

jest.mock('../../../src/bard/ai/scope', () => ({
    runWithSessionScope: (_sessionId: string, work: () => unknown) => work(),
}));

import {
    enqueueSessionProcessing,
    sessionProcessingProcessor,
} from '../../../src/services/sessionProcessing';

describe('durable session processing hand-off', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sessionProcessingGetJob.mockResolvedValue(undefined);
        finalizationGetJob.mockResolvedValue(undefined);
    });

    it('uses one deterministic no-auto-retry job per session', async () => {
        await enqueueSessionProcessing('session-1', 'guild-1', 'channel-1');
        expect(sessionProcessingAdd).toHaveBeenCalledWith(
            'process-session',
            { sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1' },
            expect.objectContaining({ jobId: 'session-session-1', attempts: 1, removeOnFail: false }),
        );
    });

    it('replaces an inert terminal job during crash recovery', async () => {
        const remove = jest.fn().mockResolvedValue(undefined);
        sessionProcessingGetJob.mockResolvedValue({
            getState: jest.fn().mockResolvedValue('failed'),
            remove,
        });

        await enqueueSessionProcessing('session-1', 'guild-1');

        expect(remove).toHaveBeenCalled();
        expect(sessionProcessingAdd).toHaveBeenCalled();
    });

    it('does not duplicate a session orchestration that is already active', async () => {
        sessionProcessingGetJob.mockResolvedValue({
            getState: jest.fn().mockResolvedValue('active'),
            remove: jest.fn(),
        });

        await enqueueSessionProcessing('session-1', 'guild-1');

        expect(sessionProcessingAdd).not.toHaveBeenCalled();
    });

    it('mixes, enqueues audio, waits for terminal DB state and hands metrics to gateway', async () => {
        const secured = {
            session_id: 'session-1', filename: 'speaker.flac', filepath: '/tmp/speaker.flac',
            user_id: 'user-1', status: 'SECURED',
        };
        getSessionRecordings
            .mockReturnValueOnce([secured])
            .mockReturnValueOnce([secured])
            .mockReturnValue([{ ...secured, status: 'PROCESSED' }]);

        await sessionProcessingProcessor({
            data: { sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1' },
        } as any);

        expect(mixSessionAudio).toHaveBeenCalledWith('session-1', true);
        expect(audioAdd).toHaveBeenCalledWith(
            'transcribe-job',
            expect.objectContaining({ sessionId: 'session-1', fileName: 'speaker.flac' }),
            expect.objectContaining({ jobId: 'speaker.flac', attempts: 5 }),
        );
        expect(finalizationAdd).toHaveBeenCalledWith(
            'finalize-session',
            expect.objectContaining({
                sessionId: 'session-1',
                guildId: 'guild-1',
                metrics: expect.objectContaining({ totalAudioDurationSec: 60 }),
            }),
            expect.objectContaining({ jobId: 'finalize-session-1', attempts: 1 }),
        );
        expect(discardSession).toHaveBeenCalledWith('session-1');
    });
});
