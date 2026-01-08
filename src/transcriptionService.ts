import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';

// Configurazione Whisper
const WHISPER_BIN = process.env.WHISPER_BIN || '/app/whisper/main';
const WHISPER_MODEL = process.env.WHISPER_MODEL || '/app/whisper/models/ggml-medium.bin';

// Lista delle allucinazioni note di Whisper (Italiano + Inglese/Internazionale)
// Queste frasi compaiono spesso durante il silenzio o rumore di fondo.
const WHISPER_HALLUCINATIONS = [
    // Italiano (Varianti comuni)
    "Sottotitoli creati dalla comunità",
    "Sottotitoli a cura di",
    "Sottotitoli e revisione",
    "Traduzione a cura di",
    "Sottotitolato da",
    "Sottotitoli di",
    "Tastiera:",
    "Regia:",
    
    // Inglese / Internazionale (Residui dataset YouTube/TV)
    "Amara.org",
    "Subtitle by",
    "Subtitles by",
    "Translated by",
    "Thanks for watching",
    "Thank you for watching",
    "Please subscribe",
    "Copyright",
    "All rights reserved",
    "MBC", // Canale TV spesso nei training data
    "Al Jazeera",
    
    // Rumori trascritti come testo
    "(Musica)",
    "(Music)",
    "(Applausi)",
    "(Applause)",
    "(Silenzio)",
    "(Silence)",
    "..." // A volte lascia solo puntini
];

export interface TranscriptionSegment {
    start: number;
    end: number;
    text: string;
}

export interface TranscriptionResult {
    segments: TranscriptionSegment[];
    language?: string;
    text?: string;
}

export class WhisperCppService {
    async transcribe(audioPath: string): Promise<TranscriptionResult> {
        return new Promise((resolve, reject) => {
            if (!fs.existsSync(audioPath)) {
                return reject(new Error(`File audio non trovato: ${audioPath}`));
            }

            // Parametri ottimizzati per whisper.cpp
            const args = [
                '-n', '10',       // Nice level (priorità bassa)
                WHISPER_BIN,
                '-m', WHISPER_MODEL,
                '-f', audioPath,
                '-l', 'it',       // Lingua Italiana
                '-t', '3',        // Thread (non esagerare per non bloccare l'event loop)
                '-oj',            // Output JSON
                '-osrt', 'false'  // No SRT
            ];

            // Eseguiamo il comando direttamente (senza shell wrapper per sicurezza)
            // Nota: 'nice' deve essere disponibile nel container. Se non c'è, rimuovi '-n', '10'.
            const proc = spawn('nice', args);

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.stderr.on('data', (data) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                if (code !== 0) {
                    console.error(`[Whisper] Errore (code ${code}): ${stderr}`);
                    return reject(new Error(`Whisper process exited with code ${code}`));
                }

                // Whisper.cpp con -oj crea un file .json accanto all'audio
                const jsonPath = audioPath + '.json';
                
                if (fs.existsSync(jsonPath)) {
                    try {
                        const rawData = fs.readFileSync(jsonPath, 'utf-8');
                        const json = JSON.parse(rawData);
                        
                        // Pulizia file temporaneo JSON
                        fs.unlinkSync(jsonPath);
                        
                        resolve(this.mapToResult(json));
                    } catch (e) {
                        reject(new Error(`Errore parsing JSON Whisper: ${e}`));
                    }
                } else {
                    reject(new Error("File JSON di output non trovato."));
                }
            });
        });
    }

    private mapToResult(cppJson: any): TranscriptionResult {
        const segments: TranscriptionSegment[] = (cppJson.transcription || []).map((s: any) => {
            let start = 0;
            let end = 0;

            if (s.offsets) {
                start = s.offsets.from / 1000;
                end = s.offsets.to / 1000;
            } else if (s.timestamps) {
                start = this.parseTimestamp(s.timestamps.from);
                end = this.parseTimestamp(s.timestamps.to);
            }

            let text = s.text?.trim() || "";

            // --- FILTRO ANTI-ALLUCINAZIONI ---
            
            // 1. Controllo Frasi Vietate (Case Insensitive)
            const lowerText = text.toLowerCase();
            for (const badPhrase of WHISPER_HALLUCINATIONS) {
                if (lowerText.includes(badPhrase.toLowerCase())) {
                    // Se contiene una frase "tossica", svuotiamo il segmento.
                    // Durante il silenzio, l'allucinazione è quasi sempre l'unica cosa presente.
                    text = ""; 
                    break; 
                }
            }

            // 2. Controllo caratteri ripetuti (Loop hallucination es: "ehm ehm ehm ehm...")
            if (this.isRepetitiveLoop(text)) {
                text = "";
            }
            // ---------------------------------

            return {
                start,
                end,
                text: text
            };
        }).filter((s: TranscriptionSegment) => s.text.length > 0); // Rimuoviamo i segmenti diventati vuoti

        const fullText = segments.map(s => s.text).join(" ");

        return {
            text: fullText,
            segments: segments,
            language: "it"
        };
    }

    private parseTimestamp(ts: string): number {
        // Formato: "00:00:01,450"
        const parts = ts.split(',');
        const timeParts = parts[0].split(':');
        const ms = parseInt(parts[1] || '0');
        
        const h = parseInt(timeParts[0]);
        const m = parseInt(timeParts[1]);
        const s = parseInt(timeParts[2]);

        return (h * 3600) + (m * 60) + s + (ms / 1000);
    }

    // Helper per rilevare loop (opzionale ma utile)
    private isRepetitiveLoop(text: string): boolean {
        if (text.length < 20) return false;
        const words = text.split(' ');
        if (words.length < 5) return false;
        
        // Se il 50% delle parole sono identiche, è probabilmente un loop
        const uniqueWords = new Set(words.map(w => w.toLowerCase().replace(/[^a-z]/g, '')));
        return uniqueWords.size < (words.length * 0.4);
    }
}

// Funzione Helper per convertire PCM -> WAV (Richiesto da Whisper)
export function convertPcmToWav(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(inputPath)
            .inputOptions([
                '-f s16le',
                '-ar 48000',
                '-ac 2'
            ])
            .output(outputPath)
            .outputOptions([
                '-ar 16000', // Whisper vuole 16kHz
                '-ac 1'      // Mono
            ])
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .run();
    });
}

// Istanza Singleton
const whisperService = new WhisperCppService();

export async function transcribeLocal(filePath: string) {
    return await whisperService.transcribe(filePath);
}
