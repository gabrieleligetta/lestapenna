import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getSessionStartTime } from './db';
import { uploadToOracle } from './backupService';
import { monitor } from './monitor';

// ==================== MEMORY MANAGEMENT ====================

/**
 * Livelli di stato della memoria RAM per gestione fallback conservativa
 */
export enum MemoryStatus {
    HEALTHY = 'HEALTHY',      // > 20% RAM libera - usa /dev/shm
    WARNING = 'WARNING',      // 10-20% RAM libera - logga warning
    CRITICAL = 'CRITICAL'     // < 10% RAM libera - migra su disco
}

/**
 * Controlla lo stato della RAM disponibile
 * @returns Oggetto con status, GB liberi e percentuale libera
 */
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

// OTTIMIZZAZIONE RAM DISK:
// Se siamo su Linux, usiamo la RAM per i file temporanei del mixer (/dev/shm).
// Questo azzera l'I/O su disco durante il mixing incrementale.
const isLinux = process.platform === 'linux';
const RAM_TEMP_DIR = isLinux
    ? path.join('/dev/shm', 'dnd_bot_temp_mix')
    : path.join(__dirname, '..', 'temp_mix');

// Fallback su disco per emergenze RAM
const DISK_TEMP_DIR = path.join(__dirname, '..', 'temp_mix');

// Alias per compatibilità con codice esistente
const TEMP_DIR = RAM_TEMP_DIR;

// Assicuriamoci che le cartelle esistano
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(RAM_TEMP_DIR)) fs.mkdirSync(RAM_TEMP_DIR, { recursive: true });
if (!fs.existsSync(DISK_TEMP_DIR)) fs.mkdirSync(DISK_TEMP_DIR, { recursive: true });

interface MixerState {
    sessionId: string;
    sessionStart: number;
    pendingFiles: { path: string, delay: number, userId: string }[];
    accumulatorPath: string;
    lastMixTime: number;
    mixInterval: NodeJS.Timeout;
    isMixing: boolean; // Previene mix paralleli
    finalMp3Path: string;
    isOnDisk: boolean; // Flag per tracking migrazione emergenza RAM → Disco
}

const activeMixers = new Map<string, MixerState>();

// Mix ogni 30 secondi (bilanciamento overhead/latency)
const MIX_INTERVAL_MS = 300000; // 5 Minuti (prima era 30s)

/**
 * Migrazione di emergenza: sposta l'accumulatore da /dev/shm a disco
 * Viene chiamata solo quando la RAM è in stato CRITICAL (< 10% libera)
 * Preserva tutti i dati e crea backup su Oracle Cloud come safety net
 */
async function emergencyDiskMigration(state: MixerState): Promise<void> {
    const ramPath = state.accumulatorPath;
    const diskPath = ramPath.replace('/dev/shm/dnd_bot_temp_mix', DISK_TEMP_DIR);

    // Se già su disco, skip
    if (state.isOnDisk || !ramPath.includes('/dev/shm')) {
        console.log(`[StreamMixer] ✅ Già su disco, nessuna migrazione necessaria`);
        return;
    }

    // Se l'accumulatore non esiste ancora in RAM, basta aggiornare il path
    if (!fs.existsSync(ramPath)) {
        console.log(`[StreamMixer] 📝 Accumulatore non ancora creato, switch preventivo a disco`);
        state.accumulatorPath = diskPath;
        state.isOnDisk = true;
        return;
    }

    console.log(`[StreamMixer] 💾 Migrazione emergenza: RAM → Disco`);

    // Copia con stream per non esplodere la RAM ulteriormente
    await new Promise<void>((resolve, reject) => {
        const readStream = fs.createReadStream(ramPath);
        const writeStream = fs.createWriteStream(diskPath);

        readStream.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        readStream.on('error', reject);
    });

    // Verifica integrità (confronta dimensioni)
    const ramStats = fs.statSync(ramPath);
    const diskStats = fs.statSync(diskPath);

    if (ramStats.size !== diskStats.size) {
        throw new Error(`Migrazione fallita: dimensioni diverse (RAM: ${ramStats.size}, Disk: ${diskStats.size})`);
    }

    // Rimuovi da RAM solo dopo verifica
    fs.unlinkSync(ramPath);
    const sizeMB = diskStats.size / (1024 * 1024);
    console.log(`[StreamMixer] ✅ Migrato ${sizeMB.toFixed(2)} MB su disco`);

    // Aggiorna path nello state
    state.accumulatorPath = diskPath;
    state.isOnDisk = true;

    // Backup immediato su Oracle come safety net
    const backupKey = `emergency_backups/${state.sessionId}/acc_${Date.now()}.wav`;
    console.log(`[StreamMixer] ☁️ Backup emergenza accumulatore su Oracle...`);

    try {
        await uploadToOracle(diskPath, path.basename(diskPath), state.sessionId, backupKey);
        console.log(`[StreamMixer] ✅ Accumulatore salvato su cloud: ${backupKey}`);
    } catch (e) {
        console.error(`[StreamMixer] ❌ Backup emergenza fallito (file locale comunque sicuro):`, e);
        monitor.logError('StreamMixer', `Emergency backup failed: ${e}`);
    }
}

/**
 * Avvia il mixer incrementale per una sessione
 * Questo crea un processo che accumula i file audio in tempo reale
 */
export function startStreamingMixer(sessionId: string): void {
    if (activeMixers.has(sessionId)) {
        console.log(`[StreamMixer] ⏩ Già attivo per ${sessionId}`);
        return;
    }

    let sessionStart = getSessionStartTime(sessionId);
    if (!sessionStart) {
        sessionStart = Date.now();
        console.log(`[StreamMixer] ⚠️ Nessun recording ancora, uso timestamp corrente: ${sessionStart}`);
    }
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
        isOnDisk: false, // Inizia sempre su RAM
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

    // ==================== MEMORY CHECK ====================
    // Controlla lo stato della RAM PRIMA del mix
    const memStatus = getMemoryStatus();

    if (memStatus.status === MemoryStatus.CRITICAL) {
        console.warn(`[StreamMixer] 🚨 RAM CRITICA (${memStatus.freePercent.toFixed(1)}%, ${memStatus.freeGB.toFixed(2)} GB liberi)`);
        monitor.logError('StreamMixer', `Critical RAM: ${memStatus.freePercent.toFixed(1)}%`);
        try {
            await emergencyDiskMigration(state);
        } catch (e: any) {
            console.error(`[StreamMixer] ❌ Migrazione emergenza fallita:`, e.message);
            monitor.logError('StreamMixer', `Migration failed: ${e.message}`);
        }
    } else if (memStatus.status === MemoryStatus.WARNING) {
        console.warn(`[StreamMixer] ⚠️ RAM in WARNING (${memStatus.freePercent.toFixed(1)}%, ${memStatus.freeGB.toFixed(2)} GB liberi)`);
    }
    // ======================================================

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
 * OTTIMIZZATO: Forza 48kHz e corregge i timestamp per evitare drift
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
                // console.warn(`[StreamMixer] ⚠️ File non trovato: ${f.path}`);
                return false;
            }
            const stats = fs.statSync(f.path);
            if (stats.size < 1024) return false;
            return true;
        });

        if (validFiles.length === 0) {
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
            // CORREZIONE 1: Normalizziamo anche l'accumulatore precedente per correggere eventuali drift passati
            filterComplex += `[0]aresample=48000:async=1[acc_clean];`; 
            outputTags.push('[acc_clean]');
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

            // CORREZIONE 2: aresample + async PRIMA del delay
            // Questo assicura che 1 secondo di audio sia esattamente 1 secondo di clock a 48kHz
            filterComplex += `[${realIndex}]aresample=48000:async=1,adelay=${f.delay}|${f.delay}[${tag}];`;
            outputTags.push(`[${tag}]`);
        });

        // Mix finale
        const totalInputs = outputTags.length;
        filterComplex += `${outputTags.join('')}amix=inputs=${totalInputs}:dropout_transition=0:normalize=0[out]`;

        const tempOutput = accumulatorPath.replace('.wav', '_new.wav');

        const ffmpegArgs = [
            '-threads', '1',
            ...args,
            '-filter_complex', filterComplex,
            '-map', '[out]',
            '-ac', '2',
            '-ar', '48000',     // CORREZIONE 3: Forza output a 48kHz (standard video/discord)
            '-c:a', 'pcm_s16le', // WAV standard
            tempOutput,
            '-y'
        ];

        // console.log(`[StreamMixer] 🎛️ FFmpeg Sync: ${validFiles.length} new files`);

        const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderrData = '';
        ffmpeg.stderr?.on('data', (data) => {
            stderrData += data.toString();
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                try {
                    if (fs.existsSync(accumulatorPath)) fs.unlinkSync(accumulatorPath);
                    fs.renameSync(tempOutput, accumulatorPath);
                    resolve();
                } catch (e: any) {
                    reject(new Error(`Errore rename accumulatore: ${e.message}`));
                }
            } else {
                console.error(`[StreamMixer] FFmpeg Error Log:\n${stderrData.slice(-500)}`);
                try {
                    if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
                } catch {}
                reject(new Error(`FFmpeg batch failed with code ${code}`));
            }
        });

        ffmpeg.on('error', (err) => {
            try {
                if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
            } catch {}
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
        
        // 🆕 TIMEOUT: Max 60s per flush finale
        const flushPromise = flushPendingFiles(sessionId);
        const timeoutPromise = new Promise<void>((_, reject) => 
            setTimeout(() => reject(new Error('Flush timeout')), 60000)
        );
        
        try {
            await Promise.race([flushPromise, timeoutPromise]);
        } catch (e: any) {
            console.error(`[StreamMixer] ⚠️ Flush finale fallito: ${e.message}`);
        }
        
        // Aspetta che finisca il mix
        let retries = 0;
        while (state.isMixing && retries < 10) {
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

    const stats = fs.statSync(state.finalMp3Path);
    const sizeMB = stats.size / (1024 * 1024);
    console.log(`[StreamMixer] 📊 Statistiche: ${sizeMB.toFixed(2)} MB, ${state.pendingFiles.length} file processati`);

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
            '-ar', '48000', // Aggiungi questo per coerenza totale
            '-ac', '2',
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
