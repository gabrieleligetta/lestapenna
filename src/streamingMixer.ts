import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getSessionStartTime } from './db';
import { uploadToOracle } from './backupService';

const OUTPUT_DIR = path.join(__dirname, '..', 'mixed_sessions');
const TEMP_DIR = path.join(__dirname, '..', 'temp_mix');

// Assicuriamoci che le cartelle esistano
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

interface MixerState {
    sessionId: string;
    sessionStart: number;
    pendingFiles: { path: string, delay: number, userId: string }[];
    accumulatorPath: string;
    lastMixTime: number;
    mixInterval: NodeJS.Timeout;
    isMixing: boolean; // Previene mix paralleli
    finalMp3Path: string;
}

const activeMixers = new Map<string, MixerState>();

// Mix ogni 30 secondi (bilanciamento overhead/latency)
const MIX_INTERVAL_MS = 30000;

/**
 * Avvia il mixer incrementale per una sessione
 * Questo crea un processo che accumula i file audio in tempo reale
 */
export function startStreamingMixer(sessionId: string): void {
    if (activeMixers.has(sessionId)) {
        console.log(`[StreamMixer] ⏩ Già attivo per ${sessionId}`);
        return;
    }

    const sessionStart = getSessionStartTime(sessionId);
    if (!sessionStart) {
        console.error(`[StreamMixer] ❌ Session ${sessionId} non trovata nel DB`);
        return;
    }

    const accumulatorPath = path.join(TEMP_DIR, `acc_${sessionId}.wav`);
    const finalMp3Path = path.join(OUTPUT_DIR, `session_${sessionId}_full.mp3`);
    
    // Pulizia preventiva
    try {
        if (fs.existsSync(accumulatorPath)) fs.unlinkSync(accumulatorPath);
        if (fs.existsSync(finalMp3Path)) fs.unlinkSync(finalMp3Path);
    } catch (e) {
        console.warn(`[StreamMixer] Warning pulizia file precedenti:`, e);
    }

    const state: MixerState = {
        sessionId,
        sessionStart,
        pendingFiles: [],
        accumulatorPath,
        lastMixTime: Date.now(),
        isMixing: false,
        finalMp3Path,
        mixInterval: setInterval(() => flushPendingFiles(sessionId), MIX_INTERVAL_MS)
    };

    activeMixers.set(sessionId, state);
    console.log(`[StreamMixer] ✅ Avviato per ${sessionId} (mix ogni ${MIX_INTERVAL_MS / 1000}s)`);
}

/**
 * Aggiunge un file alla coda di mix
 * Chiamato da recorder.ts ogni volta che un file viene chiuso
 */
export function addFileToStreamingMixer(
    sessionId: string,
    userId: string,
    filePath: string,
    timestamp: number
): void {
    const state = activeMixers.get(sessionId);
    if (!state) {
        console.warn(`[StreamMixer] ⚠️ Mixer non attivo per ${sessionId}, file ignorato: ${path.basename(filePath)}`);
        return;
    }

    const delay = timestamp - state.sessionStart;
    state.pendingFiles.push({ path: filePath, delay, userId });
    
    console.log(`[StreamMixer] 📥 File accodato: ${path.basename(filePath)} (delay: ${(delay / 1000).toFixed(1)}s, user: ${userId}, queue: ${state.pendingFiles.length})`);
}

/**
 * Mixa i file pending con l'accumulatore esistente
 * Chiamato automaticamente ogni MIX_INTERVAL_MS
 */
async function flushPendingFiles(sessionId: string): Promise<void> {
    const state = activeMixers.get(sessionId);
    if (!state) return;

    // Nessun file in coda
    if (state.pendingFiles.length === 0) {
        return;
    }

    // Previeni mix paralleli (safety)
    if (state.isMixing) {
        console.log(`[StreamMixer] ⏸️ Mix già in corso per ${sessionId}, skip`);
        return;
    }

    const filesToMix = [...state.pendingFiles];
    state.pendingFiles = []; // Svuota la coda
    state.isMixing = true;

    console.log(`[StreamMixer] 🔄 Flush: ${filesToMix.length} file da mixare per ${sessionId}...`);

    try {
        await mixBatch(filesToMix, state.accumulatorPath, state.sessionStart);
        state.lastMixTime = Date.now();
        console.log(`[StreamMixer] ✅ Batch mixato correttamente (${filesToMix.length} file)`);
    } catch (e: any) {
        console.error(`[StreamMixer] ❌ Errore flush:`, e.message);
        // Re-accoda i file in caso di errore per retry successivo
        state.pendingFiles.unshift(...filesToMix);
    } finally {
        state.isMixing = false;
    }
}

/**
 * Mixa un batch di file con l'accumulatore
 * Logica simile a sessionMixer.ts ma ottimizzata per piccoli batch
 */
function mixBatch(
    files: { path: string, delay: number, userId: string }[],
    accumulatorPath: string,
    sessionStart: number
): Promise<void> {
    return new Promise((resolve, reject) => {
        // Verifica che i file esistano
        const validFiles = files.filter(f => {
            if (!fs.existsSync(f.path)) {
                console.warn(`[StreamMixer] ⚠️ File non trovato: ${f.path}`);
                return false;
            }
            // Controlla durata file prima di mixare
            const stats = fs.statSync(f.path);
            if (stats.size < 1024) {
                console.warn(`File troppo piccolo, skip: ${f.path}`);
                return false;
            }
            return true;
        });

        if (validFiles.length === 0) {
            console.log(`[StreamMixer] ⏩ Nessun file valido nel batch, skip`);
            resolve();
            return;
        }

        const args: string[] = [];
        let filterComplex = "";
        const outputTags: string[] = [];

        // Se esiste accumulatore, includilo
        const hasAccumulator = fs.existsSync(accumulatorPath);
        let inputIndex = 0;

        if (hasAccumulator) {
            args.push('-i', accumulatorPath);
            outputTags.push('[0]');
            inputIndex++;
        }

        // Aggiungi i nuovi file
        validFiles.forEach((f) => {
            args.push('-i', f.path);
        });

        // Applica adelay ai nuovi file
        validFiles.forEach((f, idx) => {
            const realIndex = inputIndex + idx;
            const tag = `s${idx}`;
            
            // Delay ASSOLUTO dalla start session
            filterComplex += `[${realIndex}]adelay=${f.delay}|${f.delay}[${tag}];`;
            outputTags.push(`[${tag}]`);
        });

        // Mix finale
        const totalInputs = outputTags.length;
        filterComplex += `${outputTags.join('')}amix=inputs=${totalInputs}:dropout_transition=0:normalize=0[out]`;

        const tempOutput = `${accumulatorPath}.tmp`;

        const ffmpegArgs = [
            ...args,
            '-filter_complex', filterComplex,
            '-map', '[out]',
            '-ac', '2',
            '-c:a', 'pcm_s16le',
            tempOutput,
            '-y'
        ];

        console.log(`[StreamMixer] 🎛️ FFmpeg: ${validFiles.length + (hasAccumulator ? 1 : 0)} inputs, ${outputTags.length} streams`);

        const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderrData = '';
        ffmpeg.stderr?.on('data', (data) => {
            stderrData += data.toString();
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                // Sostituisci l'accumulatore con il nuovo mix
                try {
                    if (fs.existsSync(accumulatorPath)) fs.unlinkSync(accumulatorPath);
                    fs.renameSync(tempOutput, accumulatorPath);
                    resolve();
                } catch (e: any) {
                    reject(new Error(`Errore rename accumulatore: ${e.message}`));
                }
            } else {
                console.error(`[StreamMixer] FFmpeg stderr:`, stderrData);
                reject(new Error(`FFmpeg batch failed with code ${code}`));
            }
        });

        ffmpeg.on('error', (err) => {
            reject(new Error(`FFmpeg spawn error: ${err.message}`));
        });
    });
}

/**
 * Finalizza il mixer e converte in MP3
 * Chiamato da recorder.ts quando viene invocato disconnect()
 */
export async function stopStreamingMixer(sessionId: string): Promise<string> {
    const state = activeMixers.get(sessionId);
    if (!state) {
        throw new Error(`[StreamMixer] ❌ Mixer non trovato per ${sessionId}`);
    }

    console.log(`[StreamMixer] 🛑 Stop richiesto per ${sessionId}...`);

    // Stop interval
    clearInterval(state.mixInterval);

    // Flush finale (se ci sono file pending)
    if (state.pendingFiles.length > 0) {
        console.log(`[StreamMixer] 🔄 Flush finale: ${state.pendingFiles.length} file...`);
        
        // Forza flush anche se isMixing è true (finalizzazione)
        state.isMixing = false;
        await flushPendingFiles(sessionId);
        
        // Aspetta che finisca il mix
        let retries = 0;
        while (state.isMixing && retries < 30) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            retries++;
        }
    }

    // Conversione in MP3
    if (!fs.existsSync(state.accumulatorPath)) {
        console.warn(`[StreamMixer] Nessun file mixato per ${sessionId}, creo silenzio`);
        // Genera 1 secondo di silenzio come placeholder
        await generateSilence(state.finalMp3Path, 1);
        activeMixers.delete(sessionId);
        return state.finalMp3Path;
    }

    console.log(`[StreamMixer] 🎵 Conversione finale WAV → MP3...`);
    await convertToMp3(state.accumulatorPath, state.finalMp3Path);
    
    // Cleanup accumulatore temporaneo
    try {
        fs.unlinkSync(state.accumulatorPath);
    } catch (e) {
        console.warn(`[StreamMixer] Warning cleanup accumulatore:`, e);
    }

    // 🆕 UPLOAD SU ORACLE CLOUD
    console.log(`[StreamMixer] ☁️ Upload mix finale su Oracle...`);
    const fileName = path.basename(state.finalMp3Path);
    const customKey = `mixed_sessions/${sessionId}/${fileName}`;
    
    try {
        await uploadToOracle(state.finalMp3Path, fileName, sessionId, customKey);
        console.log(`[StreamMixer] ✅ Mix caricato su Oracle: ${customKey}`);
    } catch (e) {
        console.error(`[StreamMixer] ⚠️ Errore upload Oracle (file locale comunque disponibile):`, e);
    }

    activeMixers.delete(sessionId);
    console.log(`[StreamMixer] ✅ Mix completato: ${state.finalMp3Path}`);
    return state.finalMp3Path;
}

/**
 * Converte l'accumulatore WAV in MP3 finale
 */
function convertToMp3(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-i', inputPath,
            '-codec:a', 'libmp3lame',
            '-b:a', '128k',
            outputPath,
            '-y'
        ], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderrData = '';
        ffmpeg.stderr?.on('data', (data) => {
            stderrData += data.toString();
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                console.error(`[StreamMixer] FFmpeg MP3 stderr:`, stderrData);
                reject(new Error(`MP3 conversion failed code ${code}`));
            }
        });
        
        ffmpeg.on('error', (err) => {
            reject(new Error(`FFmpeg MP3 spawn error: ${err.message}`));
        });
    });
}

/**
 * Genera un file di silenzio (placeholder)
 */
function generateSilence(outputPath: string, durationSec: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-f', 'lavfi',
            '-i', `anullsrc=r=44100:cl=stereo`,
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

/**
 * Utility: Verifica se un mixer è attivo per una sessione
 */
export function isStreamingMixerActive(sessionId: string): boolean {
    return activeMixers.has(sessionId);
}

/**
 * Utility: Ottieni statistiche mixer (per debugging)
 */
export function getStreamingMixerStats(sessionId: string): any {
    const state = activeMixers.get(sessionId);
    if (!state) return null;

    return {
        sessionId: state.sessionId,
        pendingFiles: state.pendingFiles.length,
        isMixing: state.isMixing,
        accumulatorExists: fs.existsSync(state.accumulatorPath),
        lastMixTime: new Date(state.lastMixTime).toISOString()
    };
}
