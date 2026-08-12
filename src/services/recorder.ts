import {
    joinVoiceChannel,
    EndBehaviorType,
    getVoiceConnection,
    VoiceConnection,
    VoiceConnectionStatus,
    AudioReceiveStream
} from '@discordjs/voice';
import { VoiceBasedChannel } from 'discord.js';
import * as fs from 'fs';
import * as prism from 'prism-media';
import * as path from 'path';
import { Transform, TransformCallback } from 'stream';
import { spawn, ChildProcess } from 'child_process';
import { addRecording, updateRecordingStatus, getCampaignLocation, getActiveCampaign, getSessionRecordings } from '../db';
import { audioQueue } from './queue';
import { uploadToOracle } from './backup';
import { monitor } from '../monitor';
import { mixSessionAudio } from './sessionMixer';
import { clearRecording } from './recordingNotice';
import { getDiscordClient } from '../discordClient';
import { appendSegmentDiagnostic } from './audioDiagnostics';
import { sessionPhaseManager } from './SessionPhaseManager';
import { config } from '../config';
import { logger } from '../utils/logger';

const log = logger('Recorder');

// ✅ SILENCE INJECTOR WITH CUMULATIVE ACCOUNTING (Zero-Alloc)
// Keeps the file aligned with the wall clock by comparing the TOTAL bytes written with those
// expected since the start of the stream. The old version measured the gaps per packet pair:
// after a stall (network jitter, event loop blocked by in-session uploads) the first
// chunk caused silence to be injected, but the backlogged chunks arriving right after in a burst
// never reabsorbed that surplus. On short segments the drift went back to zero at the natural
// rotation; on the long segments produced by forced rotation (always-open mic) it accumulated until
// the track went out of sync in the mix. With cumulative accounting the surplus drives the
// deficit negative and the subsequent real gaps consume it before injecting again:
// the maximum drift stays bounded by the tolerance.
class SilenceInjector extends Transform {
    private startTime: number | null = null;
    private lastChunkTime: number | null = null;
    private bytesPushed: number = 0;
    private silenceInjected: number = 0;
    private injectionEvents: number = 0;
    private readonly frameSize: number = 3840; // 20ms @ 48kHz stereo 16-bit
    private readonly bytesPerMs: number = 192; // 48000 * 2 * 2 / 1000

    // Minimum deficit before injecting: below this threshold it is jitter/a momentary stall,
    // not real loss. Real losses accumulate in the deficit and cross the threshold anyway,
    // so the steady-state desynchronization stays ≤ this value.
    private static readonly TOLERANCE_BYTES =
        (parseInt(process.env.RECORDING_SYNC_TOLERANCE_MS || '', 10) || 100) * 192;

    // Buffer statico di ~1 secondo di silenzio (riutilizzabile)
    // 192 bytes/ms * 1000ms = 192000 bytes
    private static readonly ZERO_BUFFER = Buffer.alloc(192000);

    _transform(chunk: Buffer, encoding: string, callback: TransformCallback): void {
        const now = Date.now();

        if (this.startTime === null) {
            this.startTime = now;
        } else {
            const expectedBytes = (now - this.startTime) * this.bytesPerMs;
            const deficitBytes = expectedBytes - this.bytesPushed;

            if (deficitBytes > SilenceInjector.TOLERANCE_BYTES) {
                const alignedMissingBytes = Math.floor(deficitBytes / this.frameSize) * this.frameSize;
                this.silenceInjected += alignedMissingBytes;
                this.injectionEvents++;
                this.bytesPushed += alignedMissingBytes;

                // Logica di invio a blocchi per evitare allocazioni
                let remainingToSend = alignedMissingBytes;
                const maxChunkSize = SilenceInjector.ZERO_BUFFER.length;

                while (remainingToSend > 0) {
                    const chunkSize = Math.min(remainingToSend, maxChunkSize);
                    // Use subarray, which creates a reference (it does not copy memory)
                    this.push(SilenceInjector.ZERO_BUFFER.subarray(0, chunkSize));
                    remainingToSend -= chunkSize;
                }
            }
        }

        this.push(chunk);
        this.bytesPushed += chunk.length;
        this.lastChunkTime = now;
        callback();
    }

    getSilenceInjectedMs(): number {
        return Math.floor(this.silenceInjected / this.bytesPerMs);
    }

    // 🆕 Segment synchronization diagnostics: compares the wall-clock duration
    // (first→last chunk) with the audio actually written. Positive `driftMs` = audio
    // shorter than real time (uncompensated deficit, expected ≤ tolerance); negative =
    // surplus from a burst. It is there to verify the always-open-mic fix in the field.
    getDiagnostics(): { audioMs: number; wallMs: number; driftMs: number; injectedMs: number; injectionEvents: number; lastChunkTime: number | null } {
        const audioMs = Math.floor(this.bytesPushed / this.bytesPerMs);
        const wallMs = (this.startTime !== null && this.lastChunkTime !== null)
            ? this.lastChunkTime - this.startTime : 0;
        return {
            audioMs,
            wallMs,
            driftMs: wallMs - audioMs,
            injectedMs: this.getSilenceInjectedMs(),
            injectionEvents: this.injectionEvents,
            lastChunkTime: this.lastChunkTime
        };
    }
}

// Structure to track the stream's full state
interface ActiveStream {
    ffmpeg: ChildProcess;
    decoder: prism.opus.Decoder;
    silenceInjector: SilenceInjector;
    opusStream: AudioReceiveStream;
    currentPath: string;
    sessionId: string;
}

// Updated map: UserId -> Stream data
const activeStreams = new Map<string, ActiveStream>();
const connectionErrors = new Map<string, number>();
const pausedGuilds = new Set<string>();
const guildToSession = new Map<string, string>();

// 🆕 Per-session audio coverage: who we expect to hear (members present + whoever speaks)
// vs who actually produced audio. At the end of the session we warn about members with 0 audio
// (e.g. a capture drop for a user already speaking when the bot started).
const expectedSpeakers = new Map<string, Set<string>>();   // guildId -> userIds
const capturedSpeakers = new Map<string, Set<string>>();    // guildId -> userIds that actually produced audio

function markExpectedSpeaker(guildId: string, userId: string) {
    if (!expectedSpeakers.has(guildId)) expectedSpeakers.set(guildId, new Set());
    expectedSpeakers.get(guildId)!.add(userId);
}

function markCapturedSpeaker(guildId: string, userId: string) {
    if (!capturedSpeakers.has(guildId)) capturedSpeakers.set(guildId, new Set());
    capturedSpeakers.get(guildId)!.add(userId);
}

// 🆕 RECEPTION WATCHDOG — mitigates discordjs/discord.js#2992: the receiver can stop
// capturing audio after ~5 min with no errors (UDP/SSRC stall). The only known remedy: recreate
// the connection. We track the last audio chunk per guild; if no audio arrives for a threshold
// while the connection is Ready and members are present, we recreate the connection.
const guildToChannel = new Map<string, VoiceBasedChannel>();
const lastAudioAt = new Map<string, number>();             // guildId -> ts of the last PCM chunk
const guildWatchdogs = new Map<string, NodeJS.Timeout>();  // guildId -> interval
const restartingGuilds = new Set<string>();

const WATCHDOG_ENABLED = process.env.RECEIVER_WATCHDOG_ENABLED !== 'false';
const WATCHDOG_CHECK_MS = parseInt(process.env.RECEIVER_WATCHDOG_CHECK_MS || '30000', 10);
const WATCHDOG_STALL_MS = parseInt(process.env.RECEIVER_WATCHDOG_STALL_MS || '240000', 10);

// 🆕 FORCED SEGMENT ROTATION (continuous background noise): EndBehaviorType.AfterSilence
// never fires if a user's microphone never produces real silence (background
// noise, an always-"open" mic). Without this limit the stream stays open indefinitely
// and gets badly cut by the first external interruption (reconnect, watchdog #2992), losing
// the whole segment. Applied uniformly to ALL users: for those who pause normally
// the natural close on silence fires well before this timeout, so it is a no-op.
const MAX_SEGMENT_DURATION_MS = parseInt(process.env.RECORDING_MAX_SEGMENT_MS || '', 10) || 3 * 60 * 1000;

// 🆕 RECORDING FILTER CHAIN: `loudnorm` on its own amplified the background noise of
// always-open mics up to speech level (segments that were almost pure noise got
// normalized to the target loudness), filling the mix with a constant hiss. Before
// normalization now: highpass cuts the rumble below 80Hz, afftdn (FFT denoise with
// adaptive noise tracking) lowers the stationary noise. Overridable via env when a
// more/less aggressive chain is needed (e.g. adding `agate` for a full mute between sentences).
const RECORDING_AUDIO_FILTER = process.env.RECORDING_AUDIO_FILTER
    || 'highpass=f=80,afftdn=nf=-25:tn=1,loudnorm';

function markAudioActivity(guildId: string) {
    lastAudioAt.set(guildId, Date.now());
}

// 🆕 Rotation diagnostics: the last chunk of the segment closed by the rotation timer,
// to measure the real hole up to the first chunk of the next segment.
const pendingRotationCut = new Map<string, number>(); // streamKey -> epoch ms

// ✅ NUOVO: Tracking file in elaborazione
const pendingFileProcessing = new Map<string, Set<string>>(); // guildId -> Set<fileName>
const fileProcessingResolvers = new Map<string, (() => void)[]>(); // guildId -> resolver callbacks

// Per-guild stopping state to prevent race conditions between concurrent disconnects
const stoppingGuilds = new Set<string>();

// Reentrancy guard: prevents concurrent double disconnect() calls for the same guild
const activeDisconnects = new Set<string>();

export function pauseRecording(guildId: string) {
    pausedGuilds.add(guildId);
    log.info('Registrazione in PAUSA', { guildId });

    // We forcibly close the active streams to avoid recording during the pause.
    // We destroy the whole pipeline (opusStream/decoder/silenceInjector), not just ffmpeg —
    // the same pattern already used by disconnect() and by the forced rotation timer, otherwise
    // the decoder/opusStream of a paused stream stay alive and keep buffering.
    let closedCount = 0;
    for (const [key, stream] of Array.from(activeStreams)) {
        if (key.startsWith(`${guildId}-`)) {
            try { stream.opusStream.unpipe(); } catch (e) { }
            try { stream.opusStream.destroy(); } catch (e) { }
            try { stream.decoder.destroy(); } catch (e) { }
            try { stream.silenceInjector.destroy(); } catch (e) { }
            try { stream.ffmpeg.stdin?.end(); } catch (e) { }
            activeStreams.delete(key);
            pendingRotationCut.delete(key); // the gap is no longer measurable after a pause
            closedCount++;
        }
    }
    if (closedCount > 0) {
        console.log(`[Recorder] ⏸️ ${closedCount} stream audio chiusi per la pausa (Guild ${guildId}).`);
    }
}

export function resumeRecording(guildId: string) {
    pausedGuilds.delete(guildId);
    markAudioActivity(guildId); // reset the watchdog baseline: avoids a spurious restart after the pause
    log.info('Registrazione RIPRESA', { guildId });
}

export function isRecordingPaused(guildId: string): boolean {
    return pausedGuilds.has(guildId);
}

export async function connectToChannel(channel: VoiceBasedChannel, sessionId: string) {
    if (!channel.guild) return;

    const guildId = channel.guild.id;

    // Reset the pause state on connect
    pausedGuilds.delete(guildId);

    // 🆕 TRACCIA MAPPA GUILD->SESSION
    guildToSession.set(guildId, sessionId);

    guildToChannel.set(guildId, channel);

    const connection = joinChannel(channel, guildId);
    console.log(`🎙️  Connesso al canale: ${channel.name} (Sessione: ${sessionId}, Guild: ${guildId})`);

    attachReceiver(connection, channel, sessionId, guildId);
    startReceiverWatchdog(guildId);
}

function joinChannel(channel: VoiceBasedChannel, guildId: string): VoiceConnection {
    return joinVoiceChannel({
        channelId: channel.id,
        guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });
}

/**
 * Attaches the reception handlers to a connection: `speaking start` (subsequent turns /
 * late joiners) + PROACTIVE subscription on Ready (captures whoever is already speaking at startup).
 * Extracted so it can be reused by the watchdog too when it recreates the connection (#2992).
 */
function attachReceiver(connection: VoiceConnection, channel: VoiceBasedChannel, sessionId: string, guildId: string) {
    connection.receiver.speaking.on('start', (userId: string) => {
        if (stoppingGuilds.has(guildId)) return; // 🛑 Block new streams during disconnect
        if (pausedGuilds.has(guildId)) return;    // --- CHECK PAUSA ---

        // --- FILTRO BOT ---
        const user = channel.client.users.cache.get(userId);
        if (user?.bot) return;

        markExpectedSpeaker(guildId, userId);
        createListeningStream(connection.receiver, userId, sessionId, guildId);
    });

    // 🆕 PROACTIVE SUBSCRIPTION on the connection's Ready.
    // `speaking.on('start')` fires ONLY on the silence→speech transition: a user who is
    // ALREADY speaking when the bot joins never generates the event and would be lost for the whole
    // session (the "Kanuii" bug: recurring 0 files across many sessions). By attaching to all
    // the non-bot members present straight away, continuous speech is captured; `speaking start` stays
    // as the trigger for subsequent turns and for whoever joins later. The streams of silent members
    // end via AfterSilence and get cleaned up (see the cleanup in ffmpeg 'close').
    connection.on(VoiceConnectionStatus.Ready, () => {
        if (stoppingGuilds.has(guildId) || pausedGuilds.has(guildId)) return;
        try {
            const present = channel.members?.filter((m: any) => !m.user?.bot);
            let count = 0;
            for (const member of present?.values() ?? []) {
                markExpectedSpeaker(guildId, member.id);
                createListeningStream(connection.receiver, member.id, sessionId, guildId);
                count++;
            }
            if (count > 0) {
                console.log(`[Recorder] 🎯 Sottoscrizione proattiva (Ready): ${count} membri non-bot nel canale`);
            }
        } catch (e) {
            console.warn(`[Recorder] ⚠️ Sottoscrizione proattiva fallita:`, e);
        }
    });
}

// ─── WATCHDOG RICEZIONE (#2992) ──────────────────────────────────────────────

function startReceiverWatchdog(guildId: string) {
    if (!WATCHDOG_ENABLED) return;
    stopReceiverWatchdog(guildId);
    markAudioActivity(guildId); // baseline
    const interval = setInterval(() => {
        try { checkReceiverStall(guildId); } catch (e) { console.warn('[Recorder] ⚠️ Watchdog error:', e); }
    }, WATCHDOG_CHECK_MS);
    interval.unref?.();
    guildWatchdogs.set(guildId, interval);
}

function stopReceiverWatchdog(guildId: string) {
    const t = guildWatchdogs.get(guildId);
    if (t) { clearInterval(t); guildWatchdogs.delete(guildId); }
    lastAudioAt.delete(guildId);
}

function checkReceiverStall(guildId: string) {
    if (stoppingGuilds.has(guildId) || pausedGuilds.has(guildId) || restartingGuilds.has(guildId)) return;
    if (!guildToSession.has(guildId)) return;

    const connection = getVoiceConnection(guildId);
    if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) return;

    const channel = guildToChannel.get(guildId);
    const humans = channel?.members?.filter((m: any) => !m.user?.bot).size ?? 0;
    if (humans === 0) return; // nobody to hear: legitimate silence, not a stall

    const gap = Date.now() - (lastAudioAt.get(guildId) ?? Date.now());
    if (gap >= WATCHDOG_STALL_MS) {
        console.warn(`[Recorder] 🩺 Watchdog: nessun audio da ${Math.round(gap / 1000)}s con ${humans} membri presenti — sospetto stallo ricezione (#2992). Ricreo la connessione...`);
        restartReceiver(guildId).catch(e => console.error('[Recorder] ❌ restartReceiver fallito:', e));
    }
}

/**
 * Recreates the voice connection (a new UDP socket) while keeping the session active. It saves the
 * audio already captured by closing the current ffmpeg processes, destroys the old connection and re-attaches
 * the receivers: Ready re-subscribes the members present. Mitigates the silent stall #2992.
 */
async function restartReceiver(guildId: string) {
    if (restartingGuilds.has(guildId)) return;
    const channel = guildToChannel.get(guildId);
    const sessionId = guildToSession.get(guildId);
    if (!channel || !sessionId) return;

    restartingGuilds.add(guildId);
    try {
        // 1. Flush+close the active streams (saving the audio already captured) and release the keys,
        //    so the new subscription on Ready is not blocked by the activeStreams guard.
        for (const [key, stream] of Array.from(activeStreams)) {
            if (key.startsWith(`${guildId}-`)) {
                try { stream.ffmpeg.stdin?.end(); } catch {}
                activeStreams.delete(key);
            }
        }
        // 2. Distruggi la vecchia connessione → nuovo socket UDP al re-join.
        try { getVoiceConnection(guildId)?.destroy(); } catch {}

        // 3. Re-join and re-attach the handlers. Ready re-subscribes the members present.
        const connection = joinChannel(channel, guildId);
        attachReceiver(connection, channel, sessionId, guildId);
        markAudioActivity(guildId); // reset baseline per non ri-triggerare subito
        console.log(`[Recorder] 🔄 Ricezione ricreata per Guild ${guildId} (watchdog #2992).`);
    } finally {
        restartingGuilds.delete(guildId);
    }
}

/**
 * 🆕 Immediately re-subscribes a member who (re)joins the bot's channel during an
 * active session. Needed for the LEAVE/REJOIN case: on rejoin Discord assigns a NEW
 * SSRC and the `speaking.on('start')` event often does not fire (or fires late) if the user
 * is already speaking, causing audio loss. Attaching straight away recovers their stream
 * as soon as the packets arrive. A no-op when the guild is not recording or is paused/stopped.
 */
export function resubscribeMemberOnRejoin(guildId: string, userId: string) {
    const sessionId = guildToSession.get(guildId);
    if (!sessionId) return; // no active session on this guild
    if (stoppingGuilds.has(guildId) || pausedGuilds.has(guildId)) return;

    const connection = getVoiceConnection(guildId);
    if (!connection) return;

    markExpectedSpeaker(guildId, userId);
    createListeningStream(connection.receiver, userId, sessionId, guildId);
    console.log(`[Recorder] 🔁 Ri-sottoscrizione su (re)join: utente ${userId} (Guild: ${guildId})`);
}

function createListeningStream(receiver: any, userId: string, sessionId: string, guildId: string) {
    const streamKey = `${guildId}-${userId}`;
    const lastError = connectionErrors.get(streamKey) || 0;
    if (Date.now() - lastError < 1000) return;

    if (activeStreams.has(streamKey)) return;

    const opusStream = receiver.subscribe(userId, {
        end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: 10000,
        },
    });

    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const silenceInjector = new SilenceInjector();

    // Capture the timestamp of the FIRST PCM chunk
    let firstChunkTimestamp: number | null = null;
    let isFirstChunk = true;
    let rotationGapMs: number | null = null; // 🆕 buco misurato rispetto al segmento ruotato precedente

    const timestampCapture = new Transform({
        transform(chunk, enc, cb) {
            if (isFirstChunk) {
                firstChunkTimestamp = Date.now();
                isFirstChunk = false;
                console.log(`[VoiceRec] 🎯 Primo chunk audio da ${userId} @ ${firstChunkTimestamp}`);

                // 🆕 If this segment comes from a forced rotation, measure the real hole
                // between the last chunk of the previous segment and this first chunk.
                const cutTime = pendingRotationCut.get(streamKey);
                if (cutTime !== undefined) {
                    pendingRotationCut.delete(streamKey);
                    rotationGapMs = firstChunkTimestamp - cutTime;
                    console.log(`[VoiceRec] 🔁 ${filename}: gap di rotazione ${rotationGapMs}ms (fine segmento precedente → primo chunk nuovo)`);
                }
            }
            markAudioActivity(guildId); // 🆕 heartbeat for the receive watchdog (#2992)
            cb(null, chunk);
        }
    });

    const getNewFile = () => {
        const filename = `${userId}-${Date.now()}.flac`;
        const filepath = path.join(config.paths.recordingsDir, filename);

        // Make sure the recordings directory exists
        const recordingsDir = path.dirname(filepath);
        if (!fs.existsSync(recordingsDir)) {
            fs.mkdirSync(recordingsDir, { recursive: true });
        }

        // Note: we no longer create the WriteStream here, ffmpeg does
        return { filepath, filename };
    };

    const { filepath, filename } = getNewFile();

    // Use spawn instead of prism.FFmpeg for more control
    const ffmpeg = spawn('ffmpeg', [
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        '-i', 'pipe:0',
        '-filter:a', RECORDING_AUDIO_FILTER,
        '-c:a', 'flac',
        '-compression_level', '5',
        '-ar', '48000',  // High Quality
        '-ac', '1',      // Mono mixdown is safe here
        '-f', 'flac',
        filepath,
        '-y'
    ]);

    // PIPELINE ERROR HANDLING (crash prevention)
    const handleError = (err: Error, source: string) => {
        if (err.message === 'Premature close') return;

        log.warn(`Errore Audio (${source}) per utente ${userId}: ${err.message}`, { guildId });

        // If the error is critical, we close OUR pipeline to avoid loops or corrupt
        // files. The key in the map must be removed only if it still points at this stream:
        // after a forced rotation it already belongs to the next segment.
        try { opusStream.destroy(); } catch { }
        try { decoder.destroy(); } catch { }
        try { ffmpeg.stdin?.end(); } catch { }
        if (activeStreams.get(streamKey)?.ffmpeg === ffmpeg) {
            activeStreams.delete(streamKey);
        }
        connectionErrors.set(streamKey, Date.now());
    };

    decoder.on('error', (e) => handleError(e, 'Decoder'));
    ffmpeg.on('error', (e) => handleError(e, 'FFmpeg'));
    ffmpeg.stdin?.on('error', (e) => {
        if ((e as NodeJS.ErrnoException).code === 'EPIPE') return; // FFmpeg already exited, ignore
        handleError(e, 'FFmpeg stdin');
    });
    opusStream.on('error', (e: Error) => handleError(e, 'OpusStream'));
    timestampCapture.on('error', (e: Error) => handleError(e, 'TimestampCapture'));
    silenceInjector.on('error', (e: Error) => handleError(e, 'SilenceInjector'));

    // NUOVA PIPELINE: Opus → Decoder → TimestampCapture → SilenceInjector → FFmpeg
    opusStream
        .pipe(decoder)
        .pipe(timestampCapture)
        .pipe(silenceInjector)
        .pipe(ffmpeg.stdin!);

    activeStreams.set(streamKey, { ffmpeg, decoder, silenceInjector, opusStream, currentPath: filepath, sessionId });

    log.info(`Registrazione iniziata per utente ${userId}: ${filename}`, { guildId, sessionId });

    // 🆕 Forced rotation when the stream never closes naturally (see
    // MAX_SEGMENT_DURATION_MS above). Checking the identity of the ffmpeg instance
    // makes the timer a no-op when the stream has already been closed/rotated normally.
    let rotatedByTimer = false;
    const rotationTimer = setTimeout(() => {
        const current = activeStreams.get(streamKey);
        if (!current || current.ffmpeg !== ffmpeg) return;
        console.log(`[VoiceRec] ⏱️ ${filename}: nessuna pausa rilevata dopo ${MAX_SEGMENT_DURATION_MS / 1000}s — rotazione forzata del segmento (mic senza silenzio reale?).`);
        rotatedByTimer = true;
        // 🆕 Diagnostics: store the cut point so the gap on the next segment can be measured
        pendingRotationCut.set(streamKey, silenceInjector.getDiagnostics().lastChunkTime ?? Date.now());
        try { opusStream.unpipe(); } catch { }
        // 🆕 Reopen the next segment on the opus stream's 'close' instead of waiting for
        // ffmpeg's 'close' (FLAC flush + filters): the audio hole at each rotation drops
        // from hundreds of ms to ~one frame. Waiting for 'close' is necessary rather than reopening
        // synchronously: the receiver removes the subscription from its map inside a
        // 'close' listener registered before ours — before that point subscribe()
        // would return the stream that was just destroyed. We release the key now; the close
        // handler of the old ffmpeg uses the identity check and does not touch the new stream.
        activeStreams.delete(streamKey);
        opusStream.once('close', () => {
            if (!stoppingGuilds.has(guildId) && !pausedGuilds.has(guildId)) {
                createListeningStream(receiver, userId, sessionId, guildId);
            }
        });
        try { opusStream.destroy(); } catch { }
        try { decoder.destroy(); } catch { }
        try { silenceInjector.destroy(); } catch { }
        try { ffmpeg.stdin?.end(); } catch { }
    }, MAX_SEGMENT_DURATION_MS);
    rotationTimer.unref?.();

    // ✅ TRACKING: Registra file in elaborazione
    ffmpeg.on('close', async (code) => {
        try {
            if (code === 0 && firstChunkTimestamp) {
                // 🆕 Per-segment synchronization diagnostics: one log line + one persisted
                // JSONL line (which ends up in the JSON attached to the recap mail). driftMs has to
                // stay within the SilenceInjector's tolerance (~100ms).
                const diag = silenceInjector.getDiagnostics();
                console.log(
                    `[VoiceRec] ✅ ${filename}: audio=${(diag.audioMs / 1000).toFixed(1)}s wall=${(diag.wallMs / 1000).toFixed(1)}s ` +
                    `drift=${diag.driftMs}ms silenzio=+${diag.injectedMs}ms (${diag.injectionEvents} iniezioni)` +
                    (rotationGapMs !== null ? ` gapRotazione=${rotationGapMs}ms` : '')
                );
                appendSegmentDiagnostic(sessionId, {
                    file: filename,
                    userId,
                    segmentStartTs: firstChunkTimestamp,
                    audioMs: diag.audioMs,
                    wallMs: diag.wallMs,
                    driftMs: diag.driftMs,
                    injectedMs: diag.injectedMs,
                    injectionEvents: diag.injectionEvents,
                    rotationGapMs,
                    endedByForcedRotation: rotatedByTimer
                });

                markCapturedSpeaker(guildId, userId);

                // Marca come pending per tracking
                if (!pendingFileProcessing.has(guildId)) {
                    pendingFileProcessing.set(guildId, new Set());
                }
                pendingFileProcessing.get(guildId)!.add(filename);

                // USE THE REAL TIMESTAMP (first chunk)
                await onFileClosed(userId, filepath, filename, firstChunkTimestamp, sessionId, guildId);

            } else if (!firstChunkTimestamp) {
                log.warn(`${filename}: Nessun chunk audio ricevuto, file vuoto`, { guildId });
                // Pulizia file vuoto se creato
                if (fs.existsSync(filepath)) {
                    try { fs.unlinkSync(filepath); } catch { }
                }
            } else {
                log.warn(`FFmpeg exited with code ${code} for ${filename}`, { guildId });
            }
        } catch (error) {
            log.error(`Errore in onFileClosed per ${filename}`, { guildId }, error as Error);
        } finally {
            clearTimeout(rotationTimer);

            // 🆕 Clean up the active stream in EVERY case (even an empty file / no audio).
            // Without this, a proactively subscribed but silent member would stay
            // stuck in activeStreams and the guard would prevent re-attaching them when they speak.
            // Identity check: after a forced rotation the key already belongs to the
            // next segment (reopened by the rotation timer) and must not be touched.
            if (activeStreams.get(streamKey)?.ffmpeg === ffmpeg) {
                activeStreams.delete(streamKey);
            }

            // 🆕 ALWAYS remove from pending, even on error
            const pending = pendingFileProcessing.get(guildId);
            if (pending) {
                pending.delete(filename);
                if (pending.size === 0) {
                    // 🔥 EVENT TRIGGER: unblocks disconnect()
                    const resolvers = fileProcessingResolvers.get(guildId) || [];
                    resolvers.forEach(resolve => resolve());
                    fileProcessingResolvers.delete(guildId);
                }
            }
        }
    });

    opusStream.on('end', async () => {
        // The pipeline will close ffmpeg.stdin automatically if the pipe is handled correctly,
        // but to be safe we force stdin closed
        if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
            ffmpeg.stdin.end();
        }

        // 🆕 Safety net: if FFmpeg does not close within 30s after the end of the stream,
        // force-kill it to avoid zombie processes that block the next disconnect
        const STALE_TIMEOUT_MS = 30_000;
        setTimeout(() => {
            if (ffmpeg.exitCode === null) {
                log.warn(`FFmpeg stale per ${filename} — force kill dopo ${STALE_TIMEOUT_MS / 1000}s`, { guildId });
                try { ffmpeg.stdin?.destroy(); } catch {}
                try { ffmpeg.kill('SIGKILL'); } catch {}
                if (activeStreams.has(streamKey)) {
                    activeStreams.delete(streamKey);
                }
            }
        }, STALE_TIMEOUT_MS).unref(); // unref() so Node's process exit is not blocked
    });
}

async function onFileClosed(userId: string, filePath: string, fileName: string, timestamp: number, sessionId: string, guildId: string) {
    // 0. FETCH THE CURRENT LOCATION AND YEAR
    const loc = getCampaignLocation(guildId);
    const macro = loc?.macro || null;
    const micro = loc?.micro || null;

    const campaign = getActiveCampaign(guildId);
    const year = campaign?.current_year ?? null;

    // 1. SAVE TO DB (status: PENDING)
    addRecording(sessionId, fileName, filePath, userId, timestamp, macro, micro, year);

    // 2. CLOUD BACKUP (the "Keeper" puts the raw audio somewhere safe)
    // We await the upload to guarantee the file is safe before carrying on
    let fileSizeMB = 0;
    try {
        const stats = fs.statSync(filePath);
        fileSizeMB = stats.size / (1024 * 1024);
    } catch (e) { }

    try {
        const uploaded = await uploadToOracle(filePath, fileName, sessionId);
        if (uploaded) {
            updateRecordingStatus(fileName, 'SECURED');
            monitor.logFileUpload(fileSizeMB, fileSizeMB, true); // Assume 1:1 compression when the original size is unknown
        } else {
            monitor.logFileUpload(fileSizeMB, 0, false);
        }
    } catch (err) {
        log.error(`Fallimento upload per ${fileName}`, { guildId }, err as Error);
        monitor.logFileUpload(fileSizeMB, 0, false);
    }

    // 3. DO NOT ENQUEUE TRANSCRIPTION NOW.
    // The files have to stay local and will be processed (mix + whisper) when the session closes.

    log.info(`File ${fileName} salvato e backuppato. In attesa di elaborazione finale.`, { guildId, sessionId });
}

export interface DisconnectOptions {
    /** Defaults to true for backwards compatibility. Paid session flows pass false and gate explicitly. */
    processSession?: boolean;
}

export async function disconnect(guildId: string, options: DisconnectOptions = {}): Promise<boolean> {
    // Guard di rientranza: evita doppi disconnect() concorrenti
    if (activeDisconnects.has(guildId)) {
        log.warn('disconnect() già in corso, skip.', { guildId });
        return false;
    }
    activeDisconnects.add(guildId);

    const connection = getVoiceConnection(guildId);
    if (!connection) {
        activeDisconnects.delete(guildId);
        return false;
    }

    log.info('Disconnessione avviata. Chiusura streams...', { guildId });
    stoppingGuilds.add(guildId); // Per-guild block

    // A. Collect all the close promises of the active streams
    const closePromises: Promise<void>[] = [];
    const ffmpegProcs: ChildProcess[] = [];

    for (const [key, stream] of Array.from(activeStreams)) {
        if (key.startsWith(`${guildId}-`)) {
            // 🆕 Destroy the upstream pipeline BEFORE closing ffmpeg
            // This prevents opusStream/silenceInjector/decoder from carrying on writing to stdin
            try { stream.opusStream.unpipe(); } catch {}
            try { stream.opusStream.destroy(); } catch {}
            try { stream.silenceInjector.destroy(); } catch {}
            try { stream.decoder.destroy(); } catch {}

            // We create a Promise that resolves ONLY when ffmpeg really finishes
            const p = new Promise<void>((resolve) => {
                if (stream.ffmpeg.exitCode !== null) {
                    resolve(); // Already closed
                } else {
                    stream.ffmpeg.on('close', (code) => {
                        // 🆕 Explicit log: if ffmpeg closes with a non-zero code on
                        // $termina, this user's last segment may be truncated/invalid
                        // — useful to know right away instead of finding out only at mix time.
                        if (code !== 0) {
                            console.warn(`[Recorder] ⚠️ ffmpeg per ${key} chiuso con codice ${code} a fine sessione (possibile segmento troncato).`);
                        }
                        resolve();
                    });
                    stream.ffmpeg.on('error', () => resolve()); // Resolve on error too, so nothing blocks
                    // Clean close (not destroy): it gives ffmpeg the chance to do its
                    // final flush and finalize the FLAC container instead of producing a
                    // truncated file on the last segment still in progress. The timeout below (60s)
                    // stays as a backstop for the cases where ffmpeg does not close anyway.
                    try { stream.ffmpeg.stdin?.end(); } catch {}
                }
            });
            closePromises.push(p);
            ffmpegProcs.push(stream.ffmpeg);
            activeStreams.delete(key);
        }
    }

    // B. Wait for ALL the ffmpeg processes to finish (max 60s, then SIGKILL)
    if (closePromises.length > 0) {
        log.info(`Attesa chiusura di ${closePromises.length} stream audio...`, { guildId });
        const FFMPEG_TIMEOUT_MS = 60_000;
        const timeout = setTimeout(() => {
            log.warn(`Timeout chiusura ffmpeg dopo ${FFMPEG_TIMEOUT_MS / 1000}s — force kill`, { guildId });
            for (const proc of ffmpegProcs) {
                if (proc.exitCode === null) {
                    try { proc.stdin?.destroy(); } catch {} // Previeni EPIPE
                    try { proc.kill('SIGKILL'); } catch {}
                }
            }
        }, FFMPEG_TIMEOUT_MS);
        try {
            await Promise.all(closePromises);
        } finally {
            clearTimeout(timeout);
        }
    }

    // C. Wait for the "onFileClosed" logic (DB + Backup) to finish (max 5min)
    const pendingFiles = pendingFileProcessing.get(guildId);
    if (pendingFiles && pendingFiles.size > 0) {
        log.info(`Attesa elaborazione finale di ${pendingFiles.size} file...`, { guildId });

        const BACKUP_TIMEOUT_MS = 300_000; // 5 minuti
        await Promise.race([
            new Promise<void>((resolve) => {
                if (!fileProcessingResolvers.has(guildId)) {
                    fileProcessingResolvers.set(guildId, []);
                }
                fileProcessingResolvers.get(guildId)!.push(resolve);
            }),
            new Promise<void>((resolve) => setTimeout(() => {
                log.warn(`Timeout elaborazione file dopo ${BACKUP_TIMEOUT_MS / 1000}s — proseguo comunque`, { guildId });
                resolve();
            }, BACKUP_TIMEOUT_MS)),
        ]);

        log.info('Tutti i file sono stati processati.', { guildId });
    }

    const sessionId = guildToSession.get(guildId);
    guildToSession.delete(guildId);
    pendingFileProcessing.delete(guildId);
    fileProcessingResolvers.delete(guildId);

    // 🆕 connectionErrors is never cleaned up otherwise: the entries for this guild
    // (key `${guildId}-${userId}`) would accumulate for the whole life of the process.
    for (const key of Array.from(connectionErrors.keys())) {
        if (key.startsWith(`${guildId}-`)) {
            connectionErrors.delete(key);
        }
    }
    for (const key of Array.from(pendingRotationCut.keys())) {
        if (key.startsWith(`${guildId}-`)) {
            pendingRotationCut.delete(key);
        }
    }

    // 🆕 Audio coverage check: warns when an expected member produced no audio at all.
    // It flags possible capture drops (e.g. a user already speaking when the bot started).
    try {
        const expected = expectedSpeakers.get(guildId);
        const captured = capturedSpeakers.get(guildId) || new Set<string>();
        if (expected && expected.size > 0) {
            const missing = Array.from(expected).filter(uid => !captured.has(uid));
            if (missing.length > 0) {
                console.warn(`[Recorder] ⚠️ COPERTURA AUDIO: nessun audio catturato per ${missing.length} membro/i atteso/i in sessione (userId: ${missing.join(', ')}). Possibile drop di cattura — controllare connessione/ingresso del giocatore.`);
            }
        }
    } catch (e) {
        console.warn('[Recorder] ⚠️ Controllo copertura audio fallito:', e);
    }
    expectedSpeakers.delete(guildId);
    capturedSpeakers.delete(guildId);

    // 🆕 Stop the reception watchdog and release the reference to the channel.
    stopReceiverWatchdog(guildId);
    guildToChannel.delete(guildId);

    // D. LEAVE THE CHANNEL IMMEDIATELY — the bot disappears from the voice channel before the mixer
    try {
        connection.destroy();
    } catch (e) {
        log.warn('VoiceConnection already destroyed.', { guildId });
    }
    stoppingGuilds.delete(guildId);
    activeDisconnects.delete(guildId); // Release the guard: the voice connection is down

    // The `[REC]` indicator is removed HERE and not in the $stop command: sessions
    // also end on their own — auto-leave from an empty channel, the technical
    // duration cap — and a bot that stays marked «recording» when it is no longer
    // recording is worse than one that never marks itself at all.
    const guild = getDiscordClient()?.guilds.cache.get(guildId);
    if (guild) await clearRecording(guild);

    log.info('Disconnesso in sicurezza.', { guildId });

    // E. FINAL PHASE: Audio Mix + Whisper Queue — run in the BACKGROUND (fire-and-forget)
    // disconnect() returns right after E.D.; waitForCompletionAndSummarize() can start
    // immediately because the SECURED files are already considered "pending" by the poller.
    if (sessionId && options.processSession !== false) {
        void enqueueSessionProcessing(sessionId, guildId);
    }

    return true;
}

/**
 * Starts the costly pipeline. Safe to call again: queue job ids and recording
 * statuses make the handoff idempotent.
 *
 * (It used to wait on a billing authorization. There is no billing any more —
 * under BYOK the cost lands on the table's own provider account.)
 */
export async function enqueueSessionProcessing(sessionId: string, guildId: string): Promise<void> {
    log.info('Avvio Mix Sessione e Fase Whisper (background)', { guildId, sessionId });
    try {
        await mixSessionAudio(sessionId, true);

        const recordings = getSessionRecordings(sessionId);
        log.info(`Accodamento ${recordings.length} file per trascrizione`, { guildId, sessionId });

        for (const rec of recordings) {
            if (rec.status === 'PENDING' || rec.status === 'SECURED') {
                await audioQueue.add('transcribe-job', {
                    sessionId: rec.session_id,
                    fileName: rec.filename,
                    filePath: rec.filepath,
                    userId: rec.user_id
                }, {
                    jobId: rec.filename,
                    attempts: 5,
                    backoff: { type: 'exponential', delay: 2000 },
                    removeOnComplete: true,
                    removeOnFail: false
                });
            }
        }
        log.info('Fase Whisper avviata', { guildId, sessionId });
    } catch (e: any) {
        log.error('Errore nella fase finale Mix/Whisper', { guildId }, e as Error);
        try {
            sessionPhaseManager.markFailed(sessionId, `Mix/Whisper: ${e?.message || e}`);
        } catch (markErr) {
            console.error(`[Recorder] ❌ markFailed fallito per ${sessionId}:`, markErr);
        }
        throw e;
    }
}
