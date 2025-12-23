import { spawn } from 'child_process';
import * as fs from 'fs';

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

export function transcribeLocal(wavPath: string): Promise<{ text: string, error?: string }> {
    return new Promise((resolve, reject) => {
        // Chiamiamo lo script python
        const python = spawn('python3', ['transcribe.py', wavPath]);
        
        let stdout = '';
        let stderr = '';

        python.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        python.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        python.on('close', (code, signal) => {
            if (code !== 0) {
                if (stderr) console.error("Python Error:", stderr);
                const errorMsg = code === null 
                    ? `Python process killed by signal ${signal} (possibile OOM)` 
                    : `Python process exited with code ${code}`;
                return reject(new Error(errorMsg));
            }

            try {
                const jsonResult = JSON.parse(stdout.trim());
                resolve(jsonResult);
            } catch (e) {
                // Fallback se non è JSON valido
                resolve({ text: stdout.trim() });
            }
        });

        python.on('error', (err) => reject(err));
    });
}
