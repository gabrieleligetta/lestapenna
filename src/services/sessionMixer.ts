import * as fs from 'fs';
import * as path from 'path';
import { getSessionRecordings } from '../db';
import { db } from '../db/client';
import { downloadFromOracle, uploadToOracle, deleteFromOracle, getPresignedUrl } from './backup';
import { runFfmpeg } from '../utils/ffmpeg';
import { config } from '../config';
import { execFile } from 'child_process';
import { appendMixDiagnostic, resetMixDiagnostics } from './audioDiagnostics';

const RECORDINGS_DIR = config.paths.recordingsDir;
const OUTPUT_DIR = config.paths.mixedSessionsDir;
const TEMP_DIR = config.paths.tempMixDir;

// Configuration
const BATCH_SIZE = 32;
// Production keeps this at one: the worker is intentionally background work
// and must leave CPU headroom to the gateway's live per-speaker encoders.
const CONCURRENCY_LIMIT = Math.max(1, Number.parseInt(process.env.MIX_CONCURRENCY_LIMIT || '1', 10) || 1);

// Ensure directories exist
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

interface AudioFile {
    path: string;
    delay: number;
}

export async function mixSessionAudio(sessionId: string, keepLocalFiles: boolean = false): Promise<string> {
    console.log(`[Mixer] 🧱 Starting 2-Level Tree Mix for session ${sessionId}...`);

    const recordings = getSessionRecordings(sessionId);
    if (!recordings.length) {
        throw new Error("No recordings found.");
    }

    // 1. Fetch & Download recordings, Validate files
    console.log(`[Mixer] 📥 Verifying/Downloading ${recordings.length} files...`);

    const validFiles: { path: string, timestamp: number, userId: string | null }[] = [];
    const timestamps: number[] = [];
    // 🆕 Track the files lost during the mix instead of discarding them silently — the loss
    // has to be visible (DB + Discord summary), not just a log that disappears in the
    // Docker log rotation. The mix carries on with the valid files anyway (no hard fail).
    const skippedFiles: { filename: string, reason: 'missing' | 'corrupt' | 'stem_failed' }[] = [];

    for (const rec of recordings) {
        const filePath = path.join(RECORDINGS_DIR, rec.filename);

        if (!fs.existsSync(filePath)) {
            const success = await downloadFromOracle(rec.filename, filePath, sessionId);
            if (!success) {
                skippedFiles.push({ filename: rec.filename, reason: 'missing' });
                continue;
            }
        }

        try {
            const stats = fs.statSync(filePath);
            if (stats.size < 1024) {
                console.warn(`[Mixer] ⚠️ Skipping small/corrupt file: ${rec.filename}`);
                skippedFiles.push({ filename: rec.filename, reason: 'corrupt' });
                continue;
            }
        } catch (e) {
            skippedFiles.push({ filename: rec.filename, reason: 'corrupt' });
            continue;
        }

        validFiles.push({
            path: filePath,
            timestamp: rec.timestamp,
            userId: rec.user_id ?? null
        });
        timestamps.push(rec.timestamp);
    }

    if (validFiles.length === 0) throw new Error("No valid files for mixing.");

    // 2. Calculate Global Session Start (min timestamp)
    const sessionStart = Math.min(...timestamps);

    const filesToProcess: AudioFile[] = validFiles.map(f => ({
        path: f.path,
        delay: Math.max(0, f.timestamp - sessionStart)
    })).sort((a, b) => a.delay - b.delay);

    console.log(`[Mixer] 📊 Input: ${filesToProcess.length} valid files. Session Start (Epoch): ${sessionStart}`);

    // 🆕 Per-track diagnostics: the positioning delay in the master + the file's real duration
    // (ffprobe). Cross-referenced with the recorder's data it ends up in the JSON attached to the
    // recap mail, to verify that every track is placed and as long as expected.
    try {
        resetMixDiagnostics(sessionId);
        for (const f of validFiles) {
            appendMixDiagnostic(sessionId, {
                file: path.basename(f.path),
                userId: f.userId,
                mixDelayMs: Math.max(0, f.timestamp - sessionStart),
                probedDurationMs: await probeDurationMs(f.path)
            });
        }
    } catch (e) {
        console.warn(`[Mixer] ⚠️ Diagnostica tracce fallita (proseguo col mix):`, e);
    }

    // 3. Chunk files into batches
    const batches: AudioFile[][] = [];
    for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
        batches.push(filesToProcess.slice(i, i + BATCH_SIZE));
    }

    console.log(`[Mixer] 🌳 Tree Level 1: Processing ${batches.length} batches (Stems)...`);

    // 4. Process batches in parallel (with concurrency limit)
    const stemPaths: (string | null)[] = new Array(batches.length).fill(null);
    // Single stems created by the per-file fallback (a partially corrupt batch)
    const extraStemPaths: string[] = [];
    const queue = batches.map((b, i) => ({ batch: b, index: i }));
    const activePromises: Promise<void>[] = [];

    while (queue.length > 0 || activePromises.length > 0) {
        while (queue.length > 0 && activePromises.length < CONCURRENCY_LIMIT) {
            const item = queue.shift()!;
            const stemPath = path.join(TEMP_DIR, `stem_${sessionId}_${item.index}.flac`);

            const p = createStem(item.batch, stemPath).then(() => {
                stemPaths[item.index] = stemPath;
            }).catch(async err => {
                console.error(`[Mixer] Error processing batch ${item.index}:`, err);
                // 🆕 Do NOT rethrow: a failed batch must not abort the whole mix.
                // PER-FILE FALLBACK: a single corrupt file used to mark all 32 files
                // of the batch as lost — here we retry each file on its own, so
                // only the real culprit is lost (and reported).
                console.warn(`[Mixer] 🔬 Batch ${item.index}: retry per-file per isolare i file problematici...`);
                for (let fi = 0; fi < item.batch.length; fi++) {
                    const f = item.batch[fi];
                    const singlePath = path.join(TEMP_DIR, `stem_${sessionId}_${item.index}_f${fi}.flac`);
                    try {
                        await createStem([f], singlePath);
                        extraStemPaths.push(singlePath);
                    } catch {
                        skippedFiles.push({ filename: path.basename(f.path), reason: 'stem_failed' });
                    }
                }
            });

            // Wrapper to remove itself from activePromises
            const wrappedP = p.finally(() => {
                const idx = activePromises.indexOf(wrappedP);
                if (idx > -1) activePromises.splice(idx, 1);
            });
            activePromises.push(wrappedP);
        }
        if (activePromises.length > 0) {
            await Promise.race(activePromises);
        }
    }

    // Validate all stems exist before merging (batch + fallback per-file)
    const validStemPaths = stemPaths
        .concat(extraStemPaths)
        .filter((p): p is string => p !== null && fs.existsSync(p));
    if (validStemPaths.length === 0) {
        // Cleanup any leftover stem files before throwing
        cleanupStems(stemPaths.concat(extraStemPaths));
        throw new Error("No stems were created successfully.");
    }
    if (validStemPaths.length < stemPaths.length) {
        console.warn(`[Mixer] ⚠️ ${stemPaths.length - validStemPaths.length} stems missing, proceeding with ${validStemPaths.length}`);
    }
    if (skippedFiles.length > 0) {
        console.warn(`[Mixer] ⚠️ ${skippedFiles.length} file audio persi/saltati durante il mix (proseguo comunque):`, skippedFiles);
    }

    // 5. Merge stems to Master
    console.log(`[Mixer] 🌳 Tree Level 2: Merging ${validStemPaths.length} stems to Master...`);
    const finalMp3Path = path.join(OUTPUT_DIR, `session_${sessionId}_master.mp3`);
    try {
        await mergeStemsToMaster(validStemPaths, finalMp3Path);
    } catch (err) {
        // Cleanup all stems on merge failure
        cleanupStems(stemPaths.concat(extraStemPaths));
        throw err;
    }

    // 6. Upload & Cleanup
    const finalFileName = path.basename(finalMp3Path);
    const targetKey = `recordings/${sessionId}/${finalFileName}`;

    console.log(`[Mixer] ☁️ Uploading to Oracle: ${targetKey}`);
    // await deleteFromOracle(finalFileName, sessionId); // We do not delete the old master when it exists, we overwrite it
    await uploadToOracle(finalMp3Path, finalFileName, sessionId, targetKey);

    // Cleanup stems
    console.log(`[Mixer] 🧹 Cleaning up temp files...`);
    for (const stem of validStemPaths) {
        if (fs.existsSync(stem)) fs.unlinkSync(stem);
    }

    // Cleanup source files if requested
    if (!keepLocalFiles) {
        console.log(`[Mixer] 🧹 Cleaning up source files (keep=${keepLocalFiles})...`);
        for (const f of validFiles) {
            if (fs.existsSync(f.path)) {
                try {
                    fs.unlinkSync(f.path);
                } catch (e) {
                    console.warn(`[Mixer] Failed to delete source file ${f.path}`, e);
                }
            }
        }
    } else {
        console.log(`[Mixer] 🛑 Keeping source files locally (keep=${keepLocalFiles}).`);
    }

    // 🆕 Persist the audio loss (when there is one) instead of leaving it only in the Docker logs —
    // publisher/discord.ts reads it to warn in the final summary on Discord.
    if (skippedFiles.length > 0) {
        console.error(`[Mixer] ❌ Audio incompleto per sessione ${sessionId}: ${skippedFiles.length} file persi.`, skippedFiles);
        try {
            db.prepare('UPDATE sessions SET audio_mix_warning = ? WHERE session_id = ?')
                .run(JSON.stringify(skippedFiles), sessionId);
        } catch (e) {
            console.error(`[Mixer] ❌ Impossibile salvare audio_mix_warning per ${sessionId}:`, e);
        }
    }

    console.log(`[Mixer] ✅ Mix complete: ${finalMp3Path}`);
    return finalMp3Path;
}

const FFMPEG_MIX_TIMEOUT_MS = 600_000; // 10 minutes per stem/merge operation

// Real duration of the audio file via ffprobe (ms). Null when the probe fails: the diagnostics
// must never block the mix.
function probeDurationMs(filePath: string): Promise<number | null> {
    return new Promise((resolve) => {
        execFile('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'csv=p=0',
            filePath
        ], { timeout: 15_000 }, (err, stdout) => {
            if (err) return resolve(null);
            const seconds = parseFloat(stdout.trim());
            resolve(Number.isFinite(seconds) ? Math.round(seconds * 1000) : null);
        });
    });
}

function cleanupStems(stemPaths: (string | null)[]) {
    for (const stem of stemPaths) {
        if (stem && fs.existsSync(stem)) {
            try { fs.unlinkSync(stem); } catch {}
        }
    }
}

async function createStem(files: AudioFile[], outputPath: string): Promise<string> {
    const args: string[] = [];
    const filterParts: string[] = [];
    const outputTags: string[] = [];

    files.forEach((f, i) => {
        args.push('-i', f.path);
        const delayMs = Math.floor(f.delay);
        // Filter: aresample=48000,adelay=DELAY|DELAY
        filterParts.push(`[${i}]aresample=48000,adelay=${delayMs}|${delayMs}[s${i}]`);
        outputTags.push(`[s${i}]`);
    });

    const filterComplex = filterParts.join(';') + ';' +
        `${outputTags.join('')}amix=inputs=${files.length}:dropout_transition=0:normalize=0[out]`;

    await runFfmpeg([
        ...args,
        '-filter_complex', filterComplex,
        '-map', '[out]',
        '-ac', '2',
        '-ar', '48000',
        '-c:a', 'flac',
        outputPath,
        '-y'
    ], { label: 'Mixer stem', timeoutMs: FFMPEG_MIX_TIMEOUT_MS });
    return outputPath;
}

async function mergeStemsToMaster(stemPaths: string[], outputPath: string): Promise<void> {
    if (stemPaths.length === 0) {
        throw new Error("No stems to merge");
    }

    // With a single stem, conversion to MP3 is enough, without amix
    if (stemPaths.length === 1) {
        await runFfmpeg([
            '-i', stemPaths[0],
            '-codec:a', 'libmp3lame',
            '-q:a', '4', // VBR Quality 4 (~160kbps)
            '-ac', '2',
            '-ar', '48000',
            outputPath,
            '-y'
        ], { label: 'Mixer master (single)', timeoutMs: FFMPEG_MIX_TIMEOUT_MS });
        return;
    }

    const args: string[] = [];
    const filterParts: string[] = [];
    const outputTags: string[] = [];

    stemPaths.forEach((p, i) => {
        args.push('-i', p);
        // Safety check resample (clean logic)
        filterParts.push(`[${i}]aresample=48000[r${i}]`);
        outputTags.push(`[r${i}]`);
    });

    const filterComplex = filterParts.join(';') + ';' +
        `${outputTags.join('')}amix=inputs=${stemPaths.length}:dropout_transition=0:normalize=0[out]`;

    await runFfmpeg([
        ...args,
        '-filter_complex', filterComplex,
        '-map', '[out]',
        '-codec:a', 'libmp3lame',
        '-q:a', '4', // VBR Quality 4 (~160kbps)
        '-ac', '2',
        '-ar', '48000',
        outputPath,
        '-y'
    ], { label: 'Mixer master', timeoutMs: FFMPEG_MIX_TIMEOUT_MS });
}
