import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getSessionStartTime } from './db';
import { uploadToOracle } from './backupService';
import { monitor } from './monitor';

// ==================== MEMORY MANAGEMENT ====================

export enum MemoryStatus {
    HEALTHY = 'HEALTHY',      // > 20% RAM free
    WARNING = 'WARNING',      // 10-20% RAM free
    CRITICAL = 'CRITICAL'     // < 10% RAM free
}

export function getMemoryStatus(): { status: MemoryStatus; freeGB: number; freePercent: number } {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const freePercent = (freeMem / totalMem) * 100;
    const freeGB = freeMem / (1024 ** 3);

    let status = MemoryStatus.HEALTHY;
    if (freePercent < 20) status = MemoryStatus.WARNING;
    if (freePercent < 10) status = MemoryStatus.CRITICAL;

    return { status, freeGB, freePercent };
}

const OUTPUT_DIR = path.join(__dirname, '..', 'mixed_sessions');

// RAM Disk Optimization
const isLinux = process.platform === 'linux';
const RAM_TEMP_DIR = isLinux
    ? path.join('/dev/shm', 'dnd_bot_temp_mix')
    : path.join(__dirname, '..', 'temp_mix');

const DISK_TEMP_DIR = path.join(__dirname, '..', 'temp_mix');
const TEMP_DIR = RAM_TEMP_DIR;

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(RAM_TEMP_DIR)) fs.mkdirSync(RAM_TEMP_DIR, { recursive: true });
if (!fs.existsSync(DISK_TEMP_DIR)) fs.mkdirSync(DISK_TEMP_DIR, { recursive: true });

interface MixerState {
    sessionId: string;
    sessionStart: number;
    pendingFiles: { path: string, delay: number, userId: string }[];
    accumulatorPath: string; // Now .flac
    lastMixTime: number;
    mixInterval: NodeJS.Timeout;
    isMixing: boolean;
    finalMp3Path: string;
    isOnDisk: boolean;
}

const activeMixers = new Map<string, MixerState>();
const MIX_INTERVAL_MS = 300000; // 5 Minutes

async function emergencyDiskMigration(state: MixerState): Promise<void> {
    const ramPath = state.accumulatorPath;
    const diskPath = ramPath.replace('/dev/shm/dnd_bot_temp_mix', DISK_TEMP_DIR);

    if (state.isOnDisk || !ramPath.includes('/dev/shm')) {
        return;
    }

    if (!fs.existsSync(ramPath)) {
        state.accumulatorPath = diskPath;
        state.isOnDisk = true;
        return;
    }

    console.log(`[StreamMixer] 💾 Emergency Migration: RAM -> Disk`);

    await new Promise<void>((resolve, reject) => {
        const readStream = fs.createReadStream(ramPath);
        const writeStream = fs.createWriteStream(diskPath);
        readStream.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        readStream.on('error', reject);
    });

    const ramStats = fs.statSync(ramPath);
    const diskStats = fs.statSync(diskPath);

    if (ramStats.size !== diskStats.size) {
        throw new Error(`Migration failed: size mismatch`);
    }

    fs.unlinkSync(ramPath);
    state.accumulatorPath = diskPath;
    state.isOnDisk = true;

    const backupKey = `emergency_backups/${state.sessionId}/acc_${Date.now()}.flac`;
    try {
        await uploadToOracle(diskPath, path.basename(diskPath), state.sessionId, backupKey);
    } catch (e) {
        monitor.logError('StreamMixer', `Emergency backup failed: ${e}`);
    }
}

export function startStreamingMixer(sessionId: string): void {
    if (activeMixers.has(sessionId)) {
        return;
    }

    let sessionStart = getSessionStartTime(sessionId);
    if (!sessionStart) {
        sessionStart = Date.now();
    }

    // Changed to .flac for space saving
    const accumulatorPath = path.join(TEMP_DIR, `acc_${sessionId}.flac`);
    // Changed to _live.mp3 to distinguish from final master
    const finalMp3Path = path.join(OUTPUT_DIR, `session_${sessionId}_live.mp3`);
    
    try {
        if (fs.existsSync(accumulatorPath)) fs.unlinkSync(accumulatorPath);
        if (fs.existsSync(finalMp3Path)) fs.unlinkSync(finalMp3Path);
    } catch (e) {}

    const state: MixerState = {
        sessionId,
        sessionStart,
        pendingFiles: [],
        accumulatorPath,
        lastMixTime: Date.now(),
        isMixing: false,
        finalMp3Path,
        isOnDisk: false,
        mixInterval: setInterval(() => flushPendingFiles(sessionId), MIX_INTERVAL_MS)
    };

    activeMixers.set(sessionId, state);
    console.log(`[StreamMixer] ✅ Started for ${sessionId}`);
}

export function addFileToStreamingMixer(
    sessionId: string,
    userId: string,
    filePath: string,
    timestamp: number
): void {
    const state = activeMixers.get(sessionId);
    if (!state) return;

    const delay = timestamp - state.sessionStart;
    state.pendingFiles.push({ path: filePath, delay, userId });
    
    console.log(`[StreamMixer] 📥 Queued: ${path.basename(filePath)} (delay: ${(delay / 1000).toFixed(1)}s)`);
}

async function flushPendingFiles(sessionId: string): Promise<void> {
    const state = activeMixers.get(sessionId);
    if (!state) return;

    if (state.pendingFiles.length === 0) return;

    const memStatus = getMemoryStatus();
    if (memStatus.status === MemoryStatus.CRITICAL) {
        monitor.logError('StreamMixer', `Critical RAM: ${memStatus.freePercent.toFixed(1)}%`);
        try {
            await emergencyDiskMigration(state);
        } catch (e: any) {
            monitor.logError('StreamMixer', `Migration failed: ${e.message}`);
        }
    }

    if (state.isMixing) return;

    const filesToMix = [...state.pendingFiles];
    state.pendingFiles = [];
    state.isMixing = true;

    console.log(`[StreamMixer] 🔄 Flush: Mixing ${filesToMix.length} files...`);

    try {
        await mixBatch(filesToMix, state.accumulatorPath);
        state.lastMixTime = Date.now();
        console.log(`[StreamMixer] ✅ Batch mixed successfully`);
    } catch (e: any) {
        console.error(`[StreamMixer] ❌ Flush error:`, e.message);
        state.pendingFiles.unshift(...filesToMix);
    } finally {
        state.isMixing = false;
    }
}

function mixBatch(
    files: { path: string, delay: number, userId: string }[],
    accumulatorPath: string
): Promise<void> {
    return new Promise((resolve, reject) => {
        // Filtro validità file (Size check)
        const validFiles = files.filter(f => {
            if (!fs.existsSync(f.path)) return false;
            try {
                return fs.statSync(f.path).size >= 1024; // Skip header-only files
            } catch { return false; }
        });

        if (validFiles.length === 0) {
            resolve();
            return;
        }

        const args: string[] = [];
        let filterComplex = "";
        const outputTags: string[] = [];

        const hasAccumulator = fs.existsSync(accumulatorPath);
        let inputIndex = 0;

        // 1. Gestione Accumulatore (Base)
        if (hasAccumulator) {
            args.push('-i', accumulatorPath);
            // Resample per correggere drift accumulato
            filterComplex += `[0]aresample=48000:async=1[acc_clean];`; 
            outputTags.push('[acc_clean]');
            inputIndex++;
        }

        // 2. Aggiunta nuovi file
        validFiles.forEach((f) => {
            args.push('-i', f.path);
        });

        // 3. Costruzione Filtri per ogni nuovo input
        validFiles.forEach((f, idx) => {
            const realIndex = inputIndex + idx;
            const tag = `s${idx}`;
            
            // CATENA DI FILTRI PERFETTA:
            // 1. aresample=48000:async=1 -> Corregge timestamp e drift campionamento
            // 2. afade -> Micro dissolvenza (5ms) in/out per evitare "click" ai tagli
            // 3. adelay -> Posizionamento temporale preciso
            filterComplex += `[${realIndex}]aresample=48000:async=1,afade=t=in:st=0:d=0.005,afade=t=out:st=0:d=0.005,adelay=${f.delay}|${f.delay}[${tag}];`;
            outputTags.push(`[${tag}]`);
        });

        // 4. Mix Finale
        const totalInputs = outputTags.length;
        // normalize=0 è fondamentale per non avere sbalzi di volume tra un chunk e l'altro
        filterComplex += `${outputTags.join('')}amix=inputs=${totalInputs}:dropout_transition=0:normalize=0[out]`;

        const tempOutput = accumulatorPath.replace('.flac', '_new.flac');

        const ffmpegArgs = [
            '-threads', '1', // Monothread per stabilità su istanze piccole
            ...args,
            '-filter_complex', filterComplex,
            '-map', '[out]',
            '-ac', '2',
            '-ar', '48000',   // Output rigorosamente a 48kHz
            '-c:a', 'flac',   // FLAC per l'accumulatore (Lossless + Spazio ridotto in RAM)
            '-compression_level', '1', // Veloce
            tempOutput,
            '-y'
        ];

        const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderrData = '';
        ffmpeg.stderr?.on('data', (data) => stderrData += data.toString());

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                try {
                    // Scrittura atomica: sostituisci solo se tutto è andato bene
                    if (fs.existsSync(accumulatorPath)) fs.unlinkSync(accumulatorPath);
                    fs.renameSync(tempOutput, accumulatorPath);
                    resolve();
                } catch (e: any) {
                    reject(new Error(`Rename failed: ${e.message}`));
                }
            } else {
                console.error(`[StreamMixer] FFmpeg Error:\n${stderrData.slice(-500)}`);
                try { if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput); } catch {}
                reject(new Error(`FFmpeg batch failed code ${code}`));
            }
        });

        ffmpeg.on('error', (err) => {
            try { if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput); } catch {}
            reject(new Error(`FFmpeg spawn error: ${err.message}`));
        });
    });
}

export async function stopStreamingMixer(sessionId: string): Promise<string> {
    const state = activeMixers.get(sessionId);
    if (!state) {
        throw new Error(`[StreamMixer] ❌ Mixer not found for ${sessionId}`);
    }

    console.log(`[StreamMixer] 🛑 Stop requested for ${sessionId}...`);
    clearInterval(state.mixInterval);

    if (state.pendingFiles.length > 0) {
        state.isMixing = false;
        const flushPromise = flushPendingFiles(sessionId);
        const timeoutPromise = new Promise<void>((_, reject) => 
            setTimeout(() => reject(new Error('Flush timeout')), 60000)
        );
        try {
            await Promise.race([flushPromise, timeoutPromise]);
        } catch (e: any) {
            console.error(`[StreamMixer] ⚠️ Final flush failed: ${e.message}`);
        }
    }

    if (!fs.existsSync(state.accumulatorPath)) {
        await generateSilence(state.finalMp3Path, 1);
        activeMixers.delete(sessionId);
        return state.finalMp3Path;
    }

    console.log(`[StreamMixer] 🎵 Converting FLAC -> MP3...`);
    await convertToMp3(state.accumulatorPath, state.finalMp3Path);
    
    try {
        fs.unlinkSync(state.accumulatorPath);
    } catch (e) {}

    console.log(`[StreamMixer] ☁️ Uploading to Oracle...`);
    const fileName = path.basename(state.finalMp3Path);
    const customKey = `mixed_sessions/${sessionId}/${fileName}`;
    
    try {
        await uploadToOracle(state.finalMp3Path, fileName, sessionId, customKey);
    } catch (e) {
        console.error(`[StreamMixer] ⚠️ Oracle upload failed:`, e);
    }

    activeMixers.delete(sessionId);
    console.log(`[StreamMixer] ✅ Mix complete: ${state.finalMp3Path}`);
    return state.finalMp3Path;
}

function convertToMp3(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-i', inputPath,
            '-codec:a', 'libmp3lame',
            '-b:a', '128k',
            '-ar', '48000', // Ensure 48kHz
            '-ac', '2',
            outputPath,
            '-y'
        ], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderrData = '';
        ffmpeg.stderr?.on('data', (data) => stderrData += data.toString());

        ffmpeg.on('close', (code) => {
            if (code === 0) resolve();
            else {
                console.error(`[StreamMixer] MP3 conv failed:`, stderrData);
                reject(new Error(`MP3 conversion failed code ${code}`));
            }
        });
        
        ffmpeg.on('error', (err) => reject(new Error(`FFmpeg spawn error: ${err.message}`)));
    });
}

function generateSilence(outputPath: string, durationSec: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-f', 'lavfi',
            '-i', `anullsrc=r=48000:cl=stereo`,
            '-t', durationSec.toString(),
            '-q:a', '9',
            '-acodec', 'libmp3lame',
            outputPath,
            '-y'
        ], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Silence generation failed code ${code}`));
        });
    });
}

export function isStreamingMixerActive(sessionId: string): boolean {
    return activeMixers.has(sessionId);
}

export function getStreamingMixerStats(sessionId: string): any {
    const state = activeMixers.get(sessionId);
    if (!state) return null;

    const memStatus = getMemoryStatus();
    const accExists = fs.existsSync(state.accumulatorPath);
    const accSize = accExists ? fs.statSync(state.accumulatorPath).size / (1024 * 1024) : 0;

    return {
        sessionId: state.sessionId,
        pendingFiles: state.pendingFiles.length,
        isMixing: state.isMixing,
        accumulatorExists: accExists,
        accumulatorSizeMB: accSize.toFixed(2),
        isOnDisk: state.isOnDisk,
        accumulatorLocation: state.isOnDisk ? 'DISK' : 'RAM',
        lastMixTime: new Date(state.lastMixTime).toISOString(),
        memoryStatus: memStatus.status,
        freeRAM_GB: memStatus.freeGB.toFixed(2),
        freeRAM_Percent: memStatus.freePercent.toFixed(1)
    };
}
