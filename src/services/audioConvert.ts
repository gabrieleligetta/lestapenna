import { runFfmpeg } from '../utils/ffmpeg';

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

/**
 * Normalizes Discord's raw PCM into 16 kHz mono WAV, the format every
 * transcription engine expects.
 *
 * A run-to-completion conversion: it goes through `utils/ffmpeg.ts#runFfmpeg`, not
 * through a streaming process (those live only in recorder.ts).
 */
export async function convertPcmToWav(input: string, output: string): Promise<void> {
    await runFfmpeg([
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        '-i', input,
        '-ar', '16000',
        '-ac', '1',
        '-af', 'loudnorm=I=-16:LRA=11:TP=-1.5',
        output,
        '-y'
    ], { label: 'PCM→WAV' });
}
