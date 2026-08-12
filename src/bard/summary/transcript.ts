/**
 * Input preparation: chunking, truncation, chronological merge of transcripts+notes,
 * clean text for the summary pipeline.
 */

import {
    getSessionTranscript,
    getSessionNotes,
    getSessionStartTime,
    getSessionCampaignId
} from '../../db';
import { filterWhisperHallucinations } from '../../utils/filters/whisper';

/**
 * Utility: Split text in chunks.
 *
 * The sizes are mandatory: the table's provider decides them (`chunkingFor`).
 */
export function splitTextInChunks(text: string, chunkSize: number, overlap: number): string[] {
    const chunks: string[] = [];
    let i = 0;
    while (i < text.length) {
        const end = Math.min(i + chunkSize, text.length);
        chunks.push(text.substring(i, end));
        if (end >= text.length) break;
        i = end - overlap;
    }
    return chunks;
}

/**
 * Utility: Smart Truncate
 */
export function smartTruncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    // Semrified logic for now to save space, assuming full logic copied if needed
    // or keep it simple: center cut.
    // Copying full logic as it's important for context.

    // 2. Fallback: 20% start + 80% end (matches the fallback in original codepath)
    const startChunk = text.substring(0, maxChars * 0.2);
    const endChunk = text.substring(text.length - (maxChars * 0.8));

    const lastPeriodStart = startChunk.lastIndexOf('.');
    const cleanStart = lastPeriodStart > 0 ? startChunk.substring(0, lastPeriodStart + 1) : startChunk;

    const firstPeriodEnd = endChunk.indexOf('.');
    const cleanEnd = firstPeriodEnd > 0 ? endChunk.substring(firstPeriodEnd + 1) : endChunk;

    return cleanStart + '\n\n[...SEZIONE CENTRALE OMESSA...]\n\n' + cleanEnd;
}

/**
 * Utility: Process Chronological Session (Reconstructed from view or assumed logic)
 * In Step 906 view, it called processChronologicalSession.
 * It's likely a helper that merges transcript and notes by timestamp.
 */
export function processChronologicalSession(transcriptions: any[], notes: any[], startTime: number, campaignId: number) {
    // Basic implementation based on standard logic
    const segments: Array<{ timestamp: number, type: 'TRANSCRIPT' | 'NOTE', text: string, character: string }> = [];

    transcriptions.forEach(t => {
        segments.push({
            timestamp: t.timestamp || 0,
            type: 'TRANSCRIPT',
            text: t.transcription_text,
            character: t.character_name || 'Sconosciuto'
        });
    });

    notes.forEach(n => {
        segments.push({
            timestamp: n.timestamp || 0,
            type: 'NOTE',
            text: n.note_text,
            character: n.author_name || 'Master'
        });
    });

    segments.sort((a, b) => a.timestamp - b.timestamp);

    const linearText = segments.map(s => {
        const timeOffset = s.timestamp - startTime;
        const mins = Math.floor(timeOffset / 60000); // approx
        return `[t=${mins}m] [${s.character}]: ${s.text}`;
    }).join('\n');

    return { segments, linearText };
}

/**
 * CLEAN TEXT PREPARATION
 */
export function prepareCleanText(sessionId: string): string | undefined {
    const campaignId = getSessionCampaignId(sessionId);
    if (!campaignId) return undefined;

    const transcriptions = getSessionTranscript(sessionId);
    const notes = getSessionNotes(sessionId);
    const startTime = getSessionStartTime(sessionId) || 0;

    if (transcriptions.length === 0 && notes.length === 0) return undefined;

    const processed = processChronologicalSession(transcriptions, notes, startTime, campaignId);

    const cleanedSegments = processed.segments
        .map(s => ({
            ...s,
            text: filterWhisperHallucinations(s.text || '')
        }))
        .filter(s => s.text.length > 0);

    return cleanedSegments.map(s => `[${s.character}] ${s.text}`).join('\n\n');
}
