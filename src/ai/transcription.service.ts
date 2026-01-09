import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { LoggerService } from '../logger/logger.service';

const WHISPER_BIN = process.env.WHISPER_BIN || '/app/whisper/main';
const WHISPER_MODEL = process.env.WHISPER_MODEL || '/app/whisper/model.bin';

const WHISPER_HALLUCINATIONS = [
    "Sottotitoli creati dalla comunità", "Sottotitoli a cura di", "Sottotitoli e revisione",
    "Traduzione a cura di", "Sottotitolato da", "Sottotitoli di",
    "Amara.org", "QTSS", "Luca Gardella",
    "Subtitle by", "Subtitles by", "Translated by",
    "Thanks for watching", "Thank you for watching", "Please subscribe",
    "Iscrivetevi al canale", "Copyright", "All rights reserved",
    "MBC", "Al Jazeera",
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

@Injectable()
export class TranscriptionService {
    constructor(private readonly logger: LoggerService) {}

    async transcribe(filePath: string): Promise<TranscriptionResult> {
        const tempWavPath = filePath + '.temp.wav';

        try {
            this.logger.log(`[Whisper] 🔄 Conversione preliminare: ${path.basename(filePath)} -> WAV 16kHz...`);
            await this.prepareAudioForWhisper(filePath, tempWavPath);

            this.logger.log(`[Whisper] 🧠 Avvio inferenza modello...`);
            const result = await this.runWhisperProcess(tempWavPath);

            if (fs.existsSync(tempWavPath)) fs.unlinkSync(tempWavPath);

            return result;
        } catch (error) {
            if (fs.existsSync(tempWavPath)) fs.unlinkSync(tempWavPath);
            this.logger.error("[Whisper] ❌ Errore critico trascrizione:", error);
            throw error;
        }
    }

    private prepareAudioForWhisper(inputPath: string, outputPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const args = [
                '-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath
            ];
            const proc = spawn('ffmpeg', args);
            let stderr = '';
            proc.stderr.on('data', (d) => stderr += d.toString());

            proc.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
            });
            proc.on('error', (err) => reject(new Error(`Impossibile avviare FFmpeg: ${err.message}`)));
        });
    }

    private runWhisperProcess(audioPath: string): Promise<TranscriptionResult> {
        return new Promise((resolve, reject) => {
            if (!fs.existsSync(audioPath)) return reject(new Error(`File audio non trovato: ${audioPath}`));

            const args = [
                '-n', '10', WHISPER_BIN, '-m', WHISPER_MODEL, '-f', audioPath, '-l', 'it', '-t', '3', '-oj'
            ];

            const proc = spawn('nice', args);
            let stderr = '';

            proc.stderr.on('data', (data) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                if (code !== 0) {
                    this.logger.error(`[Whisper] STDERR: ${stderr}`);
                    return reject(new Error(`Whisper process exited with code ${code}`));
                }

                const jsonPath = audioPath + '.json';
                if (fs.existsSync(jsonPath)) {
                    try {
                        const rawData = fs.readFileSync(jsonPath, 'utf-8');
                        const json = JSON.parse(rawData);
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
            const lowerText = text.toLowerCase();

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
