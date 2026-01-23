/**
 * Reporter - Archives (Transcription Backup)
 */

import * as path from 'path';
import * as fs from 'fs';
import { getSessionTranscript, getSessionNotes, getSessionStartTime, db } from '../db';
import { processChronologicalSession } from '../utils/transcript';
import { uploadToOracle } from '../services/backup';
import { ArchiveResult } from './types';

/**
 * Genera e archivia le trascrizioni (Raw + Cleaned) su Oracle Cloud.
 */
export async function archiveSessionTranscripts(
    sessionId: string,
    campaignId: number,
    summaryNarrative?: string
): Promise<ArchiveResult> {
    console.log(`[Reporter] 📦 Archiviazione trascrizioni per sessione ${sessionId}...`);

    // 1. Recupero Dati
    const transcripts = getSessionTranscript(sessionId);
    const notes = getSessionNotes(sessionId);
    const startTime = getSessionStartTime(sessionId);

    if (!transcripts || transcripts.length === 0) {
        throw new Error(`Nessuna trascrizione trovata per ${sessionId}`);
    }

    // 2. Generazione Testi
    // --- ELABORAZIONE CLEANED (regex-filtered, no AI) ---
    const processedCleaned = processChronologicalSession(transcripts, notes, startTime, campaignId);
    const cleanedText = processedCleaned.formattedText;

    // --- ELABORAZIONE RAW ---
    const rawTranscripts = transcripts.map(t => {
        const recording = db.prepare(`
            SELECT raw_transcription_text
            FROM recordings
            WHERE session_id = ? AND user_id = ? AND timestamp = ?
        `).get(sessionId, t.user_id, t.timestamp) as { raw_transcription_text: string | null } | undefined;

        return {
            ...t,
            transcription_text: recording?.raw_transcription_text || "[Trascrizione grezza non disponibile]"
        };
    });

    const processedRaw = processChronologicalSession(rawTranscripts, notes, startTime, campaignId, true);
    const rawText = processedRaw.formattedText;

    // 3. Salvataggio Temporaneo
    const tempDir = path.join(__dirname, '..', '..', 'temp_emails'); // Adjust path if needed
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const cleanedPath = path.join(tempDir, `${sessionId}_cleaned.txt`);
    const rawPath = path.join(tempDir, `${sessionId}_raw_whisper.txt`);
    const summaryPath = summaryNarrative ? path.join(tempDir, `${sessionId}_summary.txt`) : undefined;

    fs.writeFileSync(cleanedPath, cleanedText, 'utf-8');
    fs.writeFileSync(rawPath, rawText, 'utf-8');
    if (summaryPath && summaryNarrative) {
        fs.writeFileSync(summaryPath, summaryNarrative, 'utf-8');
    }

    // 4. Upload su Cloud
    try {
        await uploadToOracle(cleanedPath, 'transcript_cleaned.txt', sessionId, `transcripts/${sessionId}/transcript_cleaned.txt`);
        await uploadToOracle(rawPath, 'transcript_raw.txt', sessionId, `transcripts/${sessionId}/transcript_raw.txt`);
        if (summaryPath) {
            await uploadToOracle(summaryPath, 'summary_narrative.txt', sessionId, `transcripts/${sessionId}/summary_narrative.txt`);
        }
        console.log(`[Reporter] ☁️ Trascrizioni archiviate su Oracle Cloud.`);
    } catch (e) {
        console.error(`[Reporter] ❌ Errore upload trascrizioni:`, e);
    }

    return {
        raw: rawPath,
        cleaned: cleanedPath,
        summary: summaryPath
    };
}
