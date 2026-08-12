import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';

const createdDecoders: PassThrough[] = [];
const createdFfmpegs: any[] = [];

jest.mock('prism-media', () => ({
    opus: {
        Decoder: jest.fn().mockImplementation(() => {
            const { PassThrough: PT } = require('stream');
            const d = new PT();
            createdDecoders.push(d);
            return d;
        }),
    },
}));

jest.mock('child_process', () => ({
    spawn: jest.fn().mockImplementation(() => {
        const { EventEmitter: EE } = require('events');
        const { Writable: W } = require('stream');
        const proc: any = new EE();
        proc.stdin = new W({ write(_c: any, _e: any, cb: any) { cb(); } });
        proc.exitCode = null;
        proc.kill = jest.fn();
        createdFfmpegs.push(proc);
        return proc;
    }),
}));

let fakeConnection: any;
let fakeReceiver: any;

jest.mock('@discordjs/voice', () => {
    const actual = jest.requireActual('@discordjs/voice');
    return {
        ...actual,
        joinVoiceChannel: jest.fn(() => fakeConnection),
        getVoiceConnection: jest.fn(() => fakeConnection),
    };
});

jest.mock('../../../src/db', () => ({
    addRecording: jest.fn(),
    updateRecordingStatus: jest.fn(),
    getCampaignLocation: jest.fn().mockReturnValue(null),
    getActiveCampaign: jest.fn().mockReturnValue(null),
    getSessionRecordings: jest.fn().mockReturnValue([]),
}));
jest.mock('../../../src/services/queue', () => ({ audioQueue: { add: jest.fn() } }));
jest.mock('../../../src/services/backup', () => ({ uploadToOracle: jest.fn().mockResolvedValue('ok') }));
jest.mock('../../../src/monitor', () => ({ monitor: { logFileUpload: jest.fn(), startSession: jest.fn() } }));
jest.mock('../../../src/services/sessionMixer', () => ({ mixSessionAudio: jest.fn().mockResolvedValue('/tmp/fake.mp3') }));

import { connectToChannel, resubscribeMemberOnRejoin, pauseRecording, disconnect } from '../../../src/services/recorder';

function makeFakeChannel(guildId: string) {
    return {
        id: 'chan-1',
        name: 'test-channel',
        guild: { id: guildId, voiceAdapterCreator: jest.fn() },
        client: { users: { cache: { get: jest.fn() } } },
        members: new Map(),
    } as any;
}

describe('recorder.ts — uniform teardown of the audio pipeline', () => {
    beforeEach(() => {
        createdDecoders.length = 0;
        createdFfmpegs.length = 0;
        fakeReceiver = {
            subscribe: jest.fn(() => new PassThrough()),
            speaking: { on: jest.fn() },
        };
        fakeConnection = Object.assign(new EventEmitter(), {
            receiver: fakeReceiver,
            destroy: jest.fn(),
        });
    });

    it('pauseRecording destroys opusStream and decoder, not just ffmpeg.stdin', async () => {
        const guildId = 'guild-pause-test';
        const userId = 'user-1';
        const channel = makeFakeChannel(guildId);

        await connectToChannel(channel, 'session-1');
        resubscribeMemberOnRejoin(guildId, userId);

        expect(fakeReceiver.subscribe).toHaveBeenCalled();
        const opusStream = fakeReceiver.subscribe.mock.results[0].value as PassThrough;
        const opusDestroySpy = jest.spyOn(opusStream, 'destroy');
        const decoder = createdDecoders[createdDecoders.length - 1];
        const decoderDestroySpy = jest.spyOn(decoder, 'destroy');
        const ffmpeg = createdFfmpegs[createdFfmpegs.length - 1];
        const stdinEndSpy = jest.spyOn(ffmpeg.stdin, 'end');

        pauseRecording(guildId);

        expect(opusDestroySpy).toHaveBeenCalled();
        expect(decoderDestroySpy).toHaveBeenCalled();
        expect(stdinEndSpy).toHaveBeenCalled();
    });

    it('disconnect() closes ffmpeg.stdin with end() (a clean close), not destroy()', async () => {
        const guildId = 'guild-disconnect-graceful';
        const userId = 'user-3';
        const channel = makeFakeChannel(guildId);

        await connectToChannel(channel, 'session-3');
        resubscribeMemberOnRejoin(guildId, userId);

        const ffmpeg = createdFfmpegs[createdFfmpegs.length - 1];
        const endSpy = jest.spyOn(ffmpeg.stdin, 'end');
        const destroySpy = jest.spyOn(ffmpeg.stdin, 'destroy');

        const disconnectPromise = disconnect(guildId);
        // Let the 'close' listener registered by disconnect() run, then simulate ffmpeg
        // closing right after receiving stdin.end() (the real behaviour).
        await Promise.resolve();
        ffmpeg.emit('close', 0);

        await expect(disconnectPromise).resolves.toBe(true);
        expect(endSpy).toHaveBeenCalled();
        expect(destroySpy).not.toHaveBeenCalled();
    });

    it('disconnect() completes cleanly after a pipeline error (connectionErrors cleared)', async () => {
        const guildId = 'guild-disconnect-test';
        const userId = 'user-2';
        const channel = makeFakeChannel(guildId);

        await connectToChannel(channel, 'session-2');
        resubscribeMemberOnRejoin(guildId, userId);

        const decoder = createdDecoders[createdDecoders.length - 1];
        decoder.emit('error', new Error('boom'));

        await expect(disconnect(guildId)).resolves.toBe(true);
    });
});
