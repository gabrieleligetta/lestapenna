import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

// We cannot use promisify directly if we want access to stderr on error
// const execFileAsync = promisify(execFile); 
const unlinkAsync = promisify(fs.unlink);
const readFileAsync = promisify(fs.readFile);

export interface TranscriptionSegment {
    start: number;
    end: number;
    text: string;
}

export interface TranscriptionResult {
    text?: string;
    segments?: TranscriptionSegment[];
    error?: string;
    language?: string;
}

// Paths inside container
const WHISPER_BIN = '/app/whisper/main';
const WHISPER_MODEL_LARGE = '/app/whisper/model.bin';           // large-v3 (~3GB, fallback)
const WHISPER_MODEL_DISTIL_IT = '/app/whisper/model-distil-it.bin'; // distil-it-v0.2 Q5_0 (~530MB)

// Selezione modello: distil-it (italiano ottimizzato) > large-v3 (fallback)
function detectModel(): string {
    const useDistilIt = process.env.WHISPER_DISTIL_IT !== 'false'; // default: true

    if (useDistilIt && fs.existsSync(WHISPER_MODEL_DISTIL_IT)) {
        console.log('[WhisperCpp] 🇮🇹 Modello: distil-it-v0.2 (Q5_0, ~530MB, italiano ottimizzato)');
        return WHISPER_MODEL_DISTIL_IT;
    }

    if (fs.existsSync(WHISPER_MODEL_LARGE)) {
        console.log('[WhisperCpp] 🌍 Modello: large-v3 (~3GB, multilingua)');
        return WHISPER_MODEL_LARGE;
    }

    // Fallback: prova comunque il path default
    console.warn('[WhisperCpp] ⚠️ Nessun modello trovato, provo il path default...');
    return WHISPER_MODEL_LARGE;
}

const WHISPER_MODEL = detectModel();

export class WhisperCppService {

    async transcribe(audioPath: string): Promise<TranscriptionResult> {
        const jsonOutputPath = audioPath + '.json';

        try {
            if (!fs.existsSync(WHISPER_BIN)) throw new Error(`Whisper binary missing: ${WHISPER_BIN}`);

            const args = [
                '-n', '10',
                WHISPER_BIN,
                '-m', WHISPER_MODEL,
                '-f', audioPath,
                '-l', 'it',
                '-t', '3',
                '-oj',
                // '-osrt', 'false', // REMOVED: Causes issues with some whisper.cpp versions
                '-ml', '1',
                '--split-on-word',

                // Anti-allucinazione
                '--no-speech-thold', '0.65',   // Slightly more aggressive
                '--logprob-thold', '-0.9',     // Slightly more aggressive
                '--entropy-thold', '2.2',      // Riduce loop di parole
                '--suppress-nst',              // Sopprime token non-parlato
            ];

            // Manually wrap execFile to capture stdout and stderr even on error
            await new Promise<void>((resolve, reject) => {
                execFile('/usr/bin/nice', args, (error, stdout, stderr) => {
                    // 🆕 LOGGA SOLO ERRORI REALI
                    if (stderr) {
                        const stderrStr = stderr.toString();
                        // Filtra log inutili di whisper.cpp
                        if (stderrStr.includes('error:') || stderrStr.includes('ERROR') || stderrStr.includes('failed')) {
                            console.error(`[WhisperCpp] ❌ ${stderrStr.trim()}`);
                        }
                    }

                    if (error) {
                        console.error(`[WhisperCpp] Process execution failed.`);
                        console.error(`[WhisperCpp] ERROR OBJ: ${error.message}`);

                        // Pass the stderr as part of the error message for better visibility
                        reject(new Error(`Whisper failed: ${stderr || error.message}`));
                    } else {
                        // Log aggregato invece di ogni riga
                        const lines = stdout.toString().split('\n');
                        const segmentCount = lines.filter(l => l.includes('-->')).length;
                        console.log(`[WhisperCpp] ✅ Trascrizione completata: ${segmentCount} segmenti`);
                        resolve();
                    }
                });
            });

            if (!fs.existsSync(jsonOutputPath)) {
                throw new Error("JSON output file not found. Whisper failed?");
            }

            const rawData = await readFileAsync(jsonOutputPath, 'utf-8');
            const result = JSON.parse(rawData);

            await unlinkAsync(jsonOutputPath).catch(() => { });

            return this.mapToResult(result);

        } catch (e: any) {
            // Enhanced logging in the catch block
            console.error("[WhisperCpp] Transcription EXCEPTION:", e.message);

            if (fs.existsSync(jsonOutputPath)) await unlinkAsync(jsonOutputPath).catch(() => { });
            return { error: e.message || "Unknown Error" };
        }
    }

    private mapToResult(cppJson: any): TranscriptionResult {
        const segments: TranscriptionSegment[] = (cppJson.transcription || []).map((s: any) => {
            let start = 0;
            let end = 0;

            if (s.offsets) {
                start = s.offsets.from / 1000;
                end = s.offsets.to / 1000;
            } else if (s.timestamps) {
                start = this.parseTime(s.timestamps.from);
                end = this.parseTime(s.timestamps.to);
            }

            return {
                start,
                end,
                text: s.text?.trim() || ""
            };
        });

        const fullText = segments.map(s => s.text).join(" ");

        return {
            text: fullText,
            segments: segments,
            language: "it"
        };
    }

    private parseTime(val: any): number {
        if (typeof val === 'number') return val;
        return 0;
    }
}

const whisperService = new WhisperCppService();

export function convertPcmToWav(input: string, output: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const { spawn } = require('child_process');
        const ffmpeg = spawn('ffmpeg', [
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            '-i', input,
            '-ar', '16000',
            '-ac', '1',
            '-af', 'loudnorm=I=-16:LRA=11:TP=-1.5',
            output,
            '-y'
        ]);

        ffmpeg.on('close', (code: number) => {
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited with code ${code}`));
        });
        ffmpeg.on('error', (err: Error) => reject(err));
    });
}

export function convertToLocalWav(input: string): Promise<string> {
    const output = input.replace(/\.[^/.]+$/, "") + "_local.wav";
    return new Promise((resolve, reject) => {
        const { spawn } = require('child_process');
        const ffmpeg = spawn('ffmpeg', [
            '-i', input,
            '-ar', '16000',
            '-ac', '1',
            '-c:a', 'pcm_s16le',
            output,
            '-y'
        ]);

        ffmpeg.on('close', (code: number) => {
            if (code === 0) resolve(output);
            else reject(new Error(`ffmpeg exited with code ${code}`));
        });
        ffmpeg.on('error', (err: Error) => reject(err));
    });
}

export function transcribeLocal(audioPath: string): Promise<TranscriptionResult> {
    return whisperService.transcribe(audioPath);
}

/**
 * Forza il rilascio della memoria per il modello locale.
 * Poiché whisper.cpp è un processo CLI, la memoria viene liberata automaticamente dall'OS.
 * Questa funzione serve per forzare il GC di Node.js e mantenere coerenza nell'interfaccia.
 */
export async function unloadLocalModel(): Promise<void> {
    if (global.gc) {
        console.log('[WhisperLocal] 🧹 Forzatura Garbage Collector Node.js...');
        global.gc();
    }
    // Whisper.cpp libera la memoria automaticamente alla chiusura del processo.
    console.log('[WhisperLocal] ✅ Memoria processo CLI liberata automaticamente.');
}
