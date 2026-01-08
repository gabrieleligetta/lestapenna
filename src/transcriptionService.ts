import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

// Configurazione Whisper
const WHISPER_BIN = process.env.WHISPER_BIN || '/app/whisper/main';
const WHISPER_MODEL = process.env.WHISPER_MODEL || '/app/whisper/model.bin';

// Lista delle allucinazioni (Invariata - va benissimo)
const WHISPER_HALLUCINATIONS = [
    // Standard Whisper Hallucinations
    "Sottotitoli creati dalla comunità", "Sottotitoli a cura di", "Sottotitoli e revisione",
    "Traduzione a cura di", "Sottotitolato da", "Sottotitoli di",
    "Amara.org", "QTSS", "Luca Gardella", // Trovati nel tuo file
    "Subtitle by", "Subtitles by", "Translated by",

    // YouTube / TV Hallucinations
    "Thanks for watching", "Thank you for watching", "Please subscribe",
    "Iscrivetevi al canale", "Copyright", "All rights reserved",
    "MBC", "Al Jazeera",

    // Audio descriptions (Testuale)
    "Musica", "Applausi", "Silenzio", "Sussurro", "Sigla",
    "Music", "Applause", "Silence"
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

    /**
     * Esegue la trascrizione.
     * Accetta il path di un file WAV a 16kHz già convertito.
     */
    async transcribe(audioPath: string): Promise<TranscriptionResult> {
        return new Promise((resolve, reject) => {
            if (!fs.existsSync(audioPath)) {
                return reject(new Error(`File audio non trovato: ${audioPath}`));
            }

            //

            const args = [
                '-n', '10',       // Nice level
                WHISPER_BIN,
                '-m', WHISPER_MODEL,
                '-f', audioPath,  // Qui ci aspettiamo il file WAV temporaneo
                '-l', 'it',
                '-t', '3',        // Dobbiamo tenere 3 thread perchè il server di produzione ha 4 core e 1 serve per node!
                '-oj'           // Output JSON
            ];

            const proc = spawn('nice', args);

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.stderr.on('data', (data) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                if (code !== 0) {
                    // Ora vedremo il vero errore nel log se succede ancora
                    console.error(`[Whisper] ❌ Errore Processo (code ${code}):`);
                    console.error(`[Whisper] STDERR: ${stderr}`);
                    return reject(new Error(`Whisper process exited with code ${code}`));
                }

                const jsonPath = audioPath + '.json';

                if (fs.existsSync(jsonPath)) {
                    try {
                        const rawData = fs.readFileSync(jsonPath, 'utf-8');
                        const json = JSON.parse(rawData);
                        fs.unlinkSync(jsonPath); // Pulizia JSON
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
        // Logica di mapping identica alla tua precedente
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
            const lowerText = text.toLowerCase();

            // Filtro Allucinazioni
            for (const badPhrase of WHISPER_HALLUCINATIONS) {
                if (lowerText.includes(badPhrase.toLowerCase())) {
                    text = "";
                    break;
                }
            }
            if (this.isRepetitiveLoop(text)) text = "";

            return { start, end, text };
        }).filter((s: TranscriptionSegment) => s.text.length > 0);

        const fullText = segments.map(s => s.text).join(" ");

        return { text: fullText, segments: segments, language: "it" };
    }

    private parseTimestamp(ts: string): number {
        const parts = ts.split(',');
        const timeParts = parts[0].split(':');
        const ms = parseInt(parts[1] || '0');
        const h = parseInt(timeParts[0]);
        const m = parseInt(timeParts[1]);
        const s = parseInt(timeParts[2]);
        return (h * 3600) + (m * 60) + s + (ms / 1000);
    }

    private isRepetitiveLoop(text: string): boolean {
        if (text.length < 20) return false;
        const words = text.split(' ');
        if (words.length < 5) return false;
        const uniqueWords = new Set(words.map(w => w.toLowerCase().replace(/[^a-z]/g, '')));
        return uniqueWords.size < (words.length * 0.4);
    }
}

// --- FUNZIONE DI CONVERSIONE AGGIORNATA ---

/**
 * Converte QUALSIASI input audio (MP3, OGG, PCM) nel formato richiesto da Whisper.cpp:
 * WAV 16kHz Mono 16-bit.
 */
export function prepareAudioForWhisper(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        // Costruiamo il comando FFmpeg nativo
        // ffmpeg -y -i input.mp3 -ar 16000 -ac 1 -c:a pcm_s16le output.wav
        const args = [
            '-y',              // Sovrascrivi se esiste
            '-i', inputPath,   // Input (FFmpeg rileva automaticamente se è MP3, M4A, ecc.)
            '-ar', '16000',    // Campionamento richiesto da Whisper
            '-ac', '1',        // Mono (risparmia CPU in inferenza)
            '-c:a', 'pcm_s16le', // Codec WAV standard
            outputPath         // File di uscita
        ];

        // "ffmpeg" è disponibile globalmente perché installato nel Dockerfile (Stage 3)
        const proc = spawn('ffmpeg', args);

        // Gestione errori opzionale (per debug)
        let stderr = '';
        proc.stderr.on('data', (d) => stderr += d.toString());

        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                console.error(`[FFmpeg] Errore conversione: ${stderr}`);
                reject(new Error(`FFmpeg exited with code ${code}`));
            }
        });

        proc.on('error', (err) => {
            reject(new Error(`Impossibile avviare FFmpeg: ${err.message}`));
        });
    });
}

// Istanza Singleton
const whisperService = new WhisperCppService();

/**
 * Funzione principale da chiamare dall'esterno.
 * Gestisce l'intero ciclo: Conversione -> Trascrizione -> Pulizia
 */
export async function transcribeLocal(filePath: string) {
    // 1. Definiamo un path temporaneo per il file WAV "digeribile" da Whisper
    const tempWavPath = filePath + '.temp.wav';

    try {
        console.log(`[Whisper] 🔄 Conversione preliminare: ${path.basename(filePath)} -> WAV 16kHz...`);

        // 2. Convertiamo l'MP3 (o altro) in WAV 16kHz
        await prepareAudioForWhisper(filePath, tempWavPath);

        // 3. Eseguiamo Whisper sul file WAV temporaneo
        console.log(`[Whisper] 🧠 Avvio inferenza modello...`);
        const result = await whisperService.transcribe(tempWavPath);

        // 4. Pulizia del file WAV temporaneo (l'MP3 originale non si tocca)
        if (fs.existsSync(tempWavPath)) fs.unlinkSync(tempWavPath);

        return result;

    } catch (error) {
        // Pulizia di emergenza in caso di errore
        if (fs.existsSync(tempWavPath)) fs.unlinkSync(tempWavPath);
        console.error("[Whisper] ❌ Errore critico trascrizione:", error);
        throw error;
    }
}
