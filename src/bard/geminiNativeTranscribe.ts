import * as fs from 'fs';
import { Type } from '@google/genai';
import { getGeminiAi } from './geminiNativeGenerate';
import type { ResolvedCredentials } from './ai/types';

/**
 * Transcription with Gemini, through the native SDK.
 *
 * It exists for a product reason and not a technical one: **one key for the
 * whole flow**. With OpenAI transcription has a dedicated endpoint, but a table
 * that chose Gemini for summary and chat would otherwise have to open a second
 * account just to turn audio into text.
 *
 * Gemini has no transcription endpoint: audio is an input like any other to a
 * general-purpose model, and the timings are obtained by asking for
 * **structured output**. Hence two differences worth stating:
 *
 *  - the timestamps arrive as `MM:SS`, so with **per-second precision**;
 *    OpenAI returns floats. On the recorder's three-minute segments that is
 *    enough, but it is a real loss compared with the dedicated path;
 *  - the model can wander, whereas a transcription model cannot. The rigid
 *    schema and a temperature of zero are there for that.
 *
 * In exchange it costs less: audio is worth 32 tokens per second, that is 1,920
 * tokens per minute — on a flash model, a fraction of OpenAI's per-minute price.
 */

/** The maximum the API accepts inline. Beyond that the Files API would be needed. */
const MAX_INLINE_BYTES = 20 * 1024 * 1024;

const TRANSCRIPT_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        segments: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    start: { type: Type.STRING, description: 'Start time as MM:SS' },
                    end: { type: Type.STRING, description: 'End time as MM:SS' },
                    text: { type: Type.STRING, description: 'What is said, verbatim' },
                },
                required: ['start', 'end', 'text'],
            },
        },
    },
    required: ['segments'],
} as const;

const MIME_BY_EXTENSION: Record<string, string> = {
    flac: 'audio/flac',
    wav: 'audio/wav',
    mp3: 'audio/mp3',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    pcm: 'audio/wav',
};

function mimeTypeFor(filePath: string): string {
    const extension = filePath.toLowerCase().split('.').pop() ?? '';
    return MIME_BY_EXTENSION[extension] ?? 'audio/flac';
}

/** `MM:SS` (or `HH:MM:SS`) into seconds. Returns `null` on an unexpected format. */
export function parseClockTime(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return null;

    const parts = value.trim().split(':').map(Number);
    if (parts.length === 0 || parts.some(part => !Number.isFinite(part))) return null;

    return parts.reduce((total, part) => total * 60 + part, 0);
}

export interface GeminiTranscriptionResult {
    segments: Array<{ start: number; end: number; text: string }>;
    usage: { input: number; output: number };
}

export async function transcribeWithGemini(
    creds: ResolvedCredentials,
    filePath: string,
    model: string,
    languageName: string,
): Promise<GeminiTranscriptionResult> {
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_INLINE_BYTES) {
        throw new Error(
            `TRANSCRIPTION_FILE_TOO_LARGE: ${Math.round(stats.size / 1024 / 1024)} MB, ` +
            `il massimo inline è ${MAX_INLINE_BYTES / 1024 / 1024} MB`,
        );
    }

    const ai = getGeminiAi(creds);
    const response = await ai.models.generateContent({
        model,
        contents: [{
            role: 'user',
            parts: [
                {
                    inlineData: {
                        mimeType: mimeTypeFor(filePath),
                        data: fs.readFileSync(filePath).toString('base64'),
                    },
                },
                {
                    text:
                        `Transcribe this audio verbatim in ${languageName}. ` +
                        'Split it into short segments, each with its start and end time as MM:SS. ' +
                        'Transcribe only what is actually said: do not summarise, do not translate, ' +
                        'do not add commentary, and do not invent speech during silence. ' +
                        'If the audio contains no intelligible speech, return an empty list.',
                },
            ],
        }],
        config: {
            responseMimeType: 'application/json',
            responseSchema: TRANSCRIPT_SCHEMA as any,
            // A transcription needs no imagination: any value above zero is an
            // invitation to fill the silences.
            temperature: 0,
        },
    });

    const parsed = JSON.parse(response.text ?? '{"segments":[]}');
    const segments = (parsed.segments ?? [])
        .map((segment: any) => ({
            start: parseClockTime(segment.start),
            end: parseClockTime(segment.end),
            text: typeof segment.text === 'string' ? segment.text.trim() : '',
        }))
        // A segment with no timings or no text cannot be salvaged: keeping it
        // sposterebbe la cronologia di tutta la sessione.
        .filter((segment: any) => segment.start !== null && segment.end !== null && segment.text);

    return {
        segments,
        usage: {
            input: response.usageMetadata?.promptTokenCount ?? 0,
            output: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
    };
}
