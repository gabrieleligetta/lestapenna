/**
 * Per-segment audio flow diagnostics (synchronization / silence injection).
 *
 * The recorder appends one JSONL line for every closed segment (append = crash-safe:
 * if the bot restarts between recording and publish the data stays on disk). The reporter
 * builds an aggregate JSON from it to attach to the post-session recap mail,
 * to verify the always-open-mic fixes in the field (drift, bursts, rotation gaps).
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';

const DIAG_DIR = config.paths.audioDiagnosticsDir;

export interface SegmentDiagnostic {
    file: string;
    userId: string;
    /** Epoch ms of the first PCM chunk (= the timestamp the mixer uses for alignment) */
    segmentStartTs: number;
    /** Duration of the audio written (bytes / bytesPerMs) */
    audioMs: number;
    /** Wall-clock duration first→last chunk */
    wallMs: number;
    /** wallMs - audioMs: positivo = deficit non compensato (atteso ≤ tolleranza), negativo = surplus da burst */
    driftMs: number;
    /** Silence injected by the SilenceInjector */
    injectedMs: number;
    injectionEvents: number;
    /** Hole between the end of the previous segment and this one's first chunk (only after a forced rotation) */
    rotationGapMs: number | null;
    /** true when the segment was closed by the forced rotation timer (a mic with no silence) */
    endedByForcedRotation: boolean;
}

export interface MixTrackDiagnostic {
    file: string;
    userId: string | null;
    /** Delay (ms) applied by the mixer to position the track in the master (adelay) */
    mixDelayMs: number;
    /** Real duration of the file measured with ffprobe before the mix (null when the probe failed) */
    probedDurationMs: number | null;
}

function diagFilePath(sessionId: string): string {
    return path.join(DIAG_DIR, `session_${sessionId}.jsonl`);
}

function mixFilePath(sessionId: string): string {
    return path.join(DIAG_DIR, `session_${sessionId}_mix.jsonl`);
}

export function appendSegmentDiagnostic(sessionId: string, entry: SegmentDiagnostic): void {
    try {
        if (!fs.existsSync(DIAG_DIR)) fs.mkdirSync(DIAG_DIR, { recursive: true });
        fs.appendFileSync(diagFilePath(sessionId), JSON.stringify(entry) + '\n');
    } catch (e) {
        console.warn('[AudioDiag] ⚠️ Scrittura diagnostica fallita:', e);
    }
}

// To be called at the start of a mix: the mix can be re-run (e.g. $recover) and the entries
// are append-only — without a reset every re-run would duplicate the tracks in the report.
export function resetMixDiagnostics(sessionId: string): void {
    try {
        const p = mixFilePath(sessionId);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {
        console.warn('[AudioDiag] ⚠️ Reset diagnostica mix fallito:', e);
    }
}

export function appendMixDiagnostic(sessionId: string, entry: MixTrackDiagnostic): void {
    try {
        if (!fs.existsSync(DIAG_DIR)) fs.mkdirSync(DIAG_DIR, { recursive: true });
        fs.appendFileSync(mixFilePath(sessionId), JSON.stringify(entry) + '\n');
    } catch (e) {
        console.warn('[AudioDiag] ⚠️ Scrittura diagnostica mix fallita:', e);
    }
}

function readJsonl<T>(filePath: string): T[] {
    try {
        if (!fs.existsSync(filePath)) return [];
        return fs.readFileSync(filePath, 'utf-8')
            .split('\n')
            .filter(line => line.trim().length > 0)
            .map(line => {
                try { return JSON.parse(line) as T; } catch { return null; }
            })
            .filter((e): e is T => e !== null);
    } catch (e) {
        console.warn('[AudioDiag] ⚠️ Lettura diagnostica fallita:', e);
        return [];
    }
}

export function readSessionDiagnostics(sessionId: string): SegmentDiagnostic[] {
    return readJsonl<SegmentDiagnostic>(diagFilePath(sessionId));
}

export function readMixDiagnostics(sessionId: string): MixTrackDiagnostic[] {
    return readJsonl<MixTrackDiagnostic>(mixFilePath(sessionId));
}

interface UserAggregate {
    segments: number;
    totalAudioMs: number;
    totalInjectedMs: number;
    totalInjectionEvents: number;
    maxDriftMs: number;
    minDriftMs: number;
    forcedRotations: number;
    maxRotationGapMs: number | null;
}

/**
 * Generates the aggregate JSON (per user + recorder segments + mixer-side tracks with
 * a cross-check of the durations) and writes it to disk ready to be attached to the
 * recap mail. Returns the path, or null when there is no data for the session. The caller
 * may delete the file after sending; the source JSONL files stay as an archive.
 */
export function buildSessionDiagnosticsAttachment(sessionId: string): string | null {
    const segments = readSessionDiagnostics(sessionId);
    const mixEntries = readMixDiagnostics(sessionId);
    if (segments.length === 0 && mixEntries.length === 0) return null;

    const perUser: Record<string, UserAggregate> = {};
    for (const s of segments) {
        const agg = perUser[s.userId] ??= {
            segments: 0,
            totalAudioMs: 0,
            totalInjectedMs: 0,
            totalInjectionEvents: 0,
            maxDriftMs: s.driftMs,
            minDriftMs: s.driftMs,
            forcedRotations: 0,
            maxRotationGapMs: null
        };
        agg.segments++;
        agg.totalAudioMs += s.audioMs;
        agg.totalInjectedMs += s.injectedMs;
        agg.totalInjectionEvents += s.injectionEvents;
        agg.maxDriftMs = Math.max(agg.maxDriftMs, s.driftMs);
        agg.minDriftMs = Math.min(agg.minDriftMs, s.driftMs);
        if (s.endedByForcedRotation) agg.forcedRotations++;
        if (s.rotationGapMs !== null) {
            agg.maxRotationGapMs = Math.max(agg.maxRotationGapMs ?? 0, s.rotationGapMs);
        }
    }

    // Recorder ↔ mixer cross-check per track: the duration measured by ffprobe has to
    // match the audio written by the recorder (delta ≈ 0). A significant delta
    // indicates a file truncated/eaten between recording and mix; together with mixDelayMs
    // it makes it possible to reconstruct exactly where each track sits in the master.
    const segmentByFile = new Map(segments.map(s => [s.file, s]));
    const tracks = mixEntries.map(m => {
        const seg = segmentByFile.get(m.file);
        return {
            ...m,
            recorderAudioMs: seg?.audioMs ?? null,
            durationDeltaMs: (m.probedDurationMs !== null && seg)
                ? Math.round(m.probedDurationMs - seg.audioMs) : null
        };
    });

    const report = {
        sessionId,
        generatedAt: new Date().toISOString(),
        syncToleranceMs: parseInt(process.env.RECORDING_SYNC_TOLERANCE_MS || '', 10) || 100,
        audioFilter: process.env.RECORDING_AUDIO_FILTER || 'highpass=f=80,afftdn=nf=-25:tn=1,loudnorm',
        perUser,
        segments,
        mixTracks: tracks
    };

    try {
        const outPath = path.join(DIAG_DIR, `session_${sessionId}_diagnostics.json`);
        fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
        return outPath;
    } catch (e) {
        console.warn('[AudioDiag] ⚠️ Generazione report diagnostico fallita:', e);
        return null;
    }
}
