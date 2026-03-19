import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getSessionRecordings } from '../db';
import { downloadFromOracle, uploadToOracle, deleteFromOracle, getPresignedUrl } from './backup';

const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');
const OUTPUT_DIR = path.join(__dirname, '..', 'mixed_sessions');
const TEMP_DIR = path.join(__dirname, '..', 'temp_mix');

// Configuration
const BATCH_SIZE = 32;
const CONCURRENCY_LIMIT = 4;

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

    const validFiles: { path: string, timestamp: number }[] = [];
    const timestamps: number[] = [];

    for (const rec of recordings) {
        const filePath = path.join(RECORDINGS_DIR, rec.filename);

        if (!fs.existsSync(filePath)) {
            const success = await downloadFromOracle(rec.filename, filePath, sessionId);
            if (!success) continue;
        }

        try {
            const stats = fs.statSync(filePath);
            if (stats.size < 1024) {
                // console.warn(`[Mixer] ⚠️ Skipping small/corrupt file: ${rec.filename}`);
                continue;
            }
        } catch (e) { continue; }

        validFiles.push({
            path: filePath,
            timestamp: rec.timestamp
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

    // 3. Chunk files into batches
    const batches: AudioFile[][] = [];
    for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
        batches.push(filesToProcess.slice(i, i + BATCH_SIZE));
    }

    console.log(`[Mixer] 🌳 Tree Level 1: Processing ${batches.length} batches (Stems)...`);

    // 4. Process batches in parallel (with concurrency limit)
    const stemPaths: (string | null)[] = new Array(batches.length).fill(null);
    const queue = batches.map((b, i) => ({ batch: b, index: i }));
    const activePromises: Promise<void>[] = [];

    while (queue.length > 0 || activePromises.length > 0) {
        while (queue.length > 0 && activePromises.length < CONCURRENCY_LIMIT) {
            const item = queue.shift()!;
            const stemPath = path.join(TEMP_DIR, `stem_${sessionId}_${item.index}.flac`);

            const p = createStem(item.batch, stemPath).then(() => {
                stemPaths[item.index] = stemPath;
            }).catch(err => {
                console.error(`[Mixer] Error processing batch ${item.index}:`, err);
                throw err;
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

    // Validate all stems exist before merging
    const validStemPaths = stemPaths.filter((p): p is string => p !== null && fs.existsSync(p));
    if (validStemPaths.length === 0) {
        // Cleanup any leftover stem files before throwing
        cleanupStems(stemPaths);
        throw new Error("No stems were created successfully.");
    }
    if (validStemPaths.length < stemPaths.length) {
        console.warn(`[Mixer] ⚠️ ${stemPaths.length - validStemPaths.length} stems missing, proceeding with ${validStemPaths.length}`);
    }

    // 5. Merge stems to Master
    console.log(`[Mixer] 🌳 Tree Level 2: Merging ${validStemPaths.length} stems to Master...`);
    const finalMp3Path = path.join(OUTPUT_DIR, `session_${sessionId}_master.mp3`);
    try {
        await mergeStemsToMaster(validStemPaths, finalMp3Path);
    } catch (err) {
        // Cleanup all stems on merge failure
        cleanupStems(stemPaths);
        throw err;
    }

    // 6. Upload & Cleanup
    const finalFileName = path.basename(finalMp3Path);
    const targetKey = `recordings/${sessionId}/${finalFileName}`;

    console.log(`[Mixer] ☁️ Uploading to Oracle: ${targetKey}`);
    // await deleteFromOracle(finalFileName, sessionId); // Non cancelliamo il vecchio master se esiste, lo sovrascriviamo
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

    console.log(`[Mixer] ✅ Mix complete: ${finalMp3Path}`);
    return finalMp3Path;
}

const FFMPEG_MIX_TIMEOUT_MS = 600_000; // 10 minutes per stem/merge operation

function cleanupStems(stemPaths: (string | null)[]) {
    for (const stem of stemPaths) {
        if (stem && fs.existsSync(stem)) {
            try { fs.unlinkSync(stem); } catch {}
        }
    }
}

async function createStem(files: AudioFile[], outputPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
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

        const ffmpegArgs = [
            ...args,
            '-filter_complex', filterComplex,
            '-map', '[out]',
            '-ac', '2',
            '-ar', '48000',
            '-c:a', 'flac',
            outputPath,
            '-y'
        ];

        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        let stderr = "";
        let settled = false;
        ffmpeg.stderr.on('data', d => stderr += d.toString());

        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                console.error(`[Mixer] ⚠️ FFmpeg stem creation timed out after ${FFMPEG_MIX_TIMEOUT_MS / 1000}s`);
                try { ffmpeg.kill('SIGKILL'); } catch {}
                reject(new Error(`FFmpeg stem creation timed out after ${FFMPEG_MIX_TIMEOUT_MS / 1000}s`));
            }
        }, FFMPEG_MIX_TIMEOUT_MS);

        ffmpeg.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (code === 0) resolve(outputPath);
            else {
                console.error(`[Mixer] Stem creation failed:\n${stderr.slice(-1000)}`);
                reject(new Error(`FFmpeg stem creation failed with code ${code}`));
            }
        });
        ffmpeg.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(err);
        });
    });
}

async function mergeStemsToMaster(stemPaths: string[], outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        if (stemPaths.length === 0) {
            reject(new Error("No stems to merge"));
            return;
        }

        let settled = false;

        const withTimeout = (ffmpeg: ReturnType<typeof spawn>) => {
            const timeout = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    console.error(`[Mixer] ⚠️ FFmpeg master merge timed out after ${FFMPEG_MIX_TIMEOUT_MS / 1000}s`);
                    try { ffmpeg.kill('SIGKILL'); } catch {}
                    reject(new Error(`FFmpeg master merge timed out after ${FFMPEG_MIX_TIMEOUT_MS / 1000}s`));
                }
            }, FFMPEG_MIX_TIMEOUT_MS);
            return timeout;
        };

        // If only 1 stem, just convert it
        if (stemPaths.length === 1) {
            const ffmpeg = spawn('ffmpeg', [
                '-i', stemPaths[0],
                '-codec:a', 'libmp3lame',
                '-q:a', '4', // VBR Quality 4 (~160kbps)
                '-ac', '2',
                '-ar', '48000',
                outputPath,
                '-y'
            ]);
            let stderr = "";
            const timeout = withTimeout(ffmpeg);
            ffmpeg.stderr.on('data', d => stderr += d.toString());
            ffmpeg.on('close', (code) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                if (code === 0) resolve();
                else {
                    console.error(`[Mixer] Master merge (single) failed:\n${stderr.slice(-1000)}`);
                    reject(new Error(`FFmpeg master merge failed ${code}`));
                }
            });
            ffmpeg.on('error', (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                reject(err);
            });
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

        const ffmpegArgs = [
            ...args,
            '-filter_complex', filterComplex,
            '-map', '[out]',
            '-codec:a', 'libmp3lame',
            '-q:a', '4', // VBR Quality 4 (~160kbps)
            '-ac', '2',
            '-ar', '48000',
            outputPath,
            '-y'
        ];

        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        let stderr = "";
        const timeout = withTimeout(ffmpeg);
        ffmpeg.stderr.on('data', d => stderr += d.toString());
        ffmpeg.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (code === 0) resolve();
            else {
                console.error(`[Mixer] Master merge failed:\n${stderr.slice(-1000)}`);
                reject(new Error(`FFmpeg master merge failed with code ${code}`));
            }
        });
        ffmpeg.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(err);
        });
    });
}
