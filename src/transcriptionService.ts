import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { EventEmitter } from 'events';

class WhisperWorker extends EventEmitter {
    private process: ChildProcess | null = null;
    private ready = false;
    private currentResolve: ((value: any) => void) | null = null;
    private currentReject: ((reason: any) => void) | null = null;
    private queue: { path: string, resolve: any, reject: any }[] = [];

    constructor() {
        super();
        this.init();
    }

    private init() {
        console.log("[Whisper] Avvio demone Python...");
        this.process = spawn('python3', ['transcribe.py', '--daemon']);
        
        let buffer = '';
        this.process.stdout?.on('data', (data) => {
            const str = data.toString();
            // console.log("[Whisper stdout]", str);
            
            if (str.includes("READY") && !this.ready) {
                this.ready = true;
                console.log("[Whisper] Demone pronto.");
                this.emit('ready');
                this.processNext();
                return;
            }
            
            buffer += str;
            if (buffer.includes('\n')) {
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (line.trim() && this.currentResolve) {
                        try {
                            const json = JSON.parse(line);
                            this.currentResolve(json);
                        } catch (e) {
                            this.currentResolve({ text: line });
                        }
                        this.currentResolve = null;
                        this.currentReject = null;
                        this.processNext();
                    }
                }
            }
        });

        this.process.stderr?.on('data', (data) => {
            console.error("[Whisper stderr]", data.toString());
        });

        this.process.on('close', (code) => {
            this.ready = false;
            console.warn(`[Whisper] Processo terminato (code ${code}). Riavvio tra 5s...`);
            if (this.currentReject) {
                this.currentReject(new Error("Processo Whisper terminato inaspettatamente"));
            }
            setTimeout(() => this.init(), 5000);
        });
    }

    private processNext() {
        if (!this.ready || this.currentResolve || this.queue.length === 0) return;
        
        const next = this.queue.shift();
        if (next) {
            this.currentResolve = next.resolve;
            this.currentReject = next.reject;
            this.process?.stdin?.write(next.path + '\n');
        }
    }

    async transcribe(audioPath: string): Promise<any> {
        return new Promise((resolve, reject) => {
            this.queue.push({ path: audioPath, resolve, reject });
            this.processNext();
        });
    }
}

const whisperWorker = new WhisperWorker();

export function convertPcmToWav(input: string, output: string): Promise<void> {
    return new Promise((resolve, reject) => {
        // Usiamo "ffmpeg" direttamente perché installato nel Dockerfile con apt-get
        // -f s16le -ar 48000 -ac 2 (PCM s16le 48k stereo)
        const ffmpeg = spawn('ffmpeg', [
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            '-i', input,
            output,
            '-y'
        ]);

        ffmpeg.on('close', (code, signal) => {
            if (code === 0) resolve();
            else {
                const errorMsg = code === null 
                    ? `ffmpeg killed by signal ${signal}` 
                    : `ffmpeg exited with code ${code}`;
                reject(new Error(errorMsg));
            }
        });

        ffmpeg.on('error', (err) => reject(err));
    });
}

export function transcribeLocal(audioPath: string): Promise<{ text: string, error?: string }> {
    return whisperWorker.transcribe(audioPath);
}
