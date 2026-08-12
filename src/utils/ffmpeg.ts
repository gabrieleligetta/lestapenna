import { spawn } from 'child_process';

export interface RunFfmpegOptions {
    /** Label for the error messages (e.g. 'Mixer stem', 'PCM→WAV'). */
    label?: string;
    /** Past this limit the process is killed with SIGKILL and the promise rejected. */
    timeoutMs?: number;
}

/**
 * Runs ffmpeg to completion and resolves only on exit code 0.
 * On failure it rejects including the tail of stderr (essential for
 * diagnosing wrong filters/codecs without re-running by hand).
 *
 * Do NOT use for persistent streaming ffmpeg processes (see recorder.ts):
 * this helper only covers run-to-completion conversions.
 */
export function runFfmpeg(args: string[], opts: RunFfmpegOptions = {}): Promise<void> {
    const label = opts.label || 'ffmpeg';
    return new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', args);
        let stderr = '';
        let settled = false;
        proc.stderr.on('data', d => { stderr += d.toString(); });

        const timeout = opts.timeoutMs
            ? setTimeout(() => {
                if (settled) return;
                settled = true;
                try { proc.kill('SIGKILL'); } catch { }
                reject(new Error(`[${label}] ffmpeg timed out dopo ${opts.timeoutMs! / 1000}s`));
            }, opts.timeoutMs)
            : null;

        proc.on('close', (code) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            if (code === 0) resolve();
            else reject(new Error(`[${label}] ffmpeg uscito con codice ${code}:\n${stderr.slice(-1000)}`));
        });
        proc.on('error', (err) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            reject(err);
        });
    });
}
