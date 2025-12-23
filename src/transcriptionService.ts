import { exec } from 'child_process';
import * as fs from 'fs';

export function convertPcmToWav(input: string, output: string): Promise<void> {
    return new Promise((resolve, reject) => {
        // Usiamo "ffmpeg" direttamente perché installato nel Dockerfile con apt-get
        const ffmpegCommand = "ffmpeg";
        
        // PCM s16le 48k stereo (come da tuo voicerecorder.ts)
        const cmd = `${ffmpegCommand} -f s16le -ar 48000 -ac 2 -i "${input}" "${output}" -y`;
        exec(cmd, (err) => err ? reject(err) : resolve());
    });
}

export function transcribeLocal(wavPath: string): Promise<{ text: string, error?: string }> {
    return new Promise((resolve, reject) => {
        // Chiamiamo lo script python creato prima
        const command = `python3 transcribe.py "${wavPath}"`;
        
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error("Python Error:", stderr);
                reject(error);
            } else {
                try {
                    const jsonResult = JSON.parse(stdout.trim());
                    resolve(jsonResult);
                } catch (e) {
                    // Fallback se non è JSON valido
                    resolve({ text: stdout.trim() });
                }
            }
        });
    });
}
