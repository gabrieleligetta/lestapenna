import { db } from '../client';
import { Recording, TranscriptEntry } from '../types';

export const recordingRepository = {
    addRecording: (sessionId: string, filename: string, filepath: string, userId: string, timestamp: number, macro: string | null = null, micro: string | null = null, year: number | null = null) => {
        db.prepare('INSERT INTO recordings (session_id, filename, filepath, user_id, timestamp, status, macro_location, micro_location, year) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(sessionId, filename, filepath, userId, timestamp, 'PENDING', macro, micro, year);
    },

    getSessionRecordings: (sessionId: string): Recording[] => {
        return db.prepare('SELECT * FROM recordings WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId) as Recording[];
    },

    getRecording: (filename: string): Recording | undefined => {
        return db.prepare('SELECT * FROM recordings WHERE filename = ?').get(filename) as Recording | undefined;
    },

    updateRecordingStatus: (
        filename: string,
        status: string,
        text: string | null = null,
        error: string | null = null,
        macro: string | null = null,
        micro: string | null = null,
        npcs: string[] = [],
        characterNameSnapshot: string | null = null
    ) => {
        const npcsJson = npcs.length > 0 ? JSON.stringify(npcs) : null;

        db.prepare(`
            UPDATE recordings 
            SET status = ?, transcription_text = COALESCE(?, transcription_text), error_log = ?, 
                macro_location = COALESCE(?, macro_location), micro_location = COALESCE(?, micro_location),
                present_npcs = COALESCE(?, present_npcs),
                character_name_snapshot = COALESCE(?, character_name_snapshot)
            WHERE filename = ?
        `).run(status, text, error, macro, micro, npcsJson, characterNameSnapshot, filename);
    },

    saveRawTranscription: (filename: string, rawJson: string) => {
        db.prepare('UPDATE recordings SET raw_transcription_text = ? WHERE filename = ?').run(rawJson, filename);
    },

    updateSessionPresentNPCs: (sessionId: string, npcs: string[]) => {
        const npcsJson = JSON.stringify(npcs);
        db.prepare(`
            UPDATE recordings 
            SET present_npcs = ? 
            WHERE session_id = ? AND status = 'PROCESSED'
        `).run(npcsJson, sessionId);
    },

    getUnprocessedRecordings: (): Recording[] => {
        return db.prepare(`
            SELECT * FROM recordings
            WHERE status IN ('PENDING', 'SECURED', 'QUEUED', 'PROCESSING', 'TRANSCRIBED')
        `).all() as Recording[];
    },

    resetSessionData: (sessionId: string): Recording[] => {
        db.prepare(`
            UPDATE recordings 
            SET status = 'PENDING', transcription_text = NULL, error_log = NULL, raw_transcription_text = NULL 
            WHERE session_id = ?
        `).run(sessionId);

        return recordingRepository.getSessionRecordings(sessionId);
    },

    resetUnfinishedRecordings: (sessionId: string): Recording[] => {
        db.prepare(`
             UPDATE recordings 
             SET status = 'PENDING', error_log = NULL
             WHERE session_id = ?
             AND status IN ('PROCESSING', 'FAILED', 'ERROR')
         `).run(sessionId);

        return recordingRepository.getSessionRecordings(sessionId);
    },

    getSessionTranscript: (sessionId: string): TranscriptEntry[] => {
        const rows = db.prepare(`
            SELECT transcription_text, user_id, timestamp, character_name_snapshot, macro_location, micro_location
            FROM recordings 
            WHERE session_id = ? AND status = 'PROCESSED' AND transcription_text IS NOT NULL 
            ORDER BY timestamp ASC
        `).all(sessionId) as any[];

        return rows.map(r => ({
            transcription_text: r.transcription_text,
            timestamp: r.timestamp,
            user_id: r.user_id,
            character_name: r.character_name_snapshot || null, // Map snapshot to character_name
            character_name_snapshot: r.character_name_snapshot,
            macro_location: r.macro_location,
            micro_location: r.micro_location
        }));
    },

    /**
     * Verbatim passages from the table's own recordings that mention a subject.
     *
     * This is the material nothing else in the product can reach. The RAG holds
     * entity cards, summaries and events — prose written *about* a session — so
     * the moment somebody actually said «ha i capelli bianchi» survives only
     * here, in the transcript, and only here can a description be traced back to
     * a sentence a person spoke.
     *
     * `term` is matched as a literal substring: it is escaped for LIKE and bound
     * as a parameter, never interpolated. `present_npcs` is searched too, so a
     * scene where the subject was on stage counts even when their name is not
     * repeated in the words themselves.
     */
    searchTranscripts: (
        campaignId: number,
        term: string,
        limit: number = 8,
        windowChars: number = 700,
    ): Array<{ session_id: string | null; session_number: number | null; timestamp: number | null; excerpt: string }> => {
        const needle = term.trim();
        if (!needle) return [];
        // ESCAPE makes the wildcards in a name literal; without it an entity
        // called "100%" would match every transcript in the campaign.
        const pattern = `%${needle.replace(/[\\%_]/g, character => `\\${character}`)}%`;

        const rows = db.prepare(`
            SELECT r.session_id, s.session_number, r.timestamp, r.transcription_text, r.present_npcs
            FROM recordings r
            LEFT JOIN sessions s ON s.session_id = r.session_id
            WHERE s.campaign_id = ?
              AND r.transcription_text IS NOT NULL
              AND (r.transcription_text LIKE ? ESCAPE '\\' OR r.present_npcs LIKE ? ESCAPE '\\')
            ORDER BY r.timestamp DESC
            LIMIT ?
        `).all(campaignId, pattern, pattern, Math.max(1, Math.min(limit, 20))) as any[];

        return rows.map(row => {
            const text: string = row.transcription_text ?? '';
            // Return the neighbourhood of the mention rather than the head of a
            // half-hour recording: the description of somebody is next to their
            // name, not at the start of the file.
            const at = text.toLowerCase().indexOf(needle.toLowerCase());
            const from = at < 0 ? 0 : Math.max(0, at - Math.floor(windowChars / 2));
            return {
                session_id: row.session_id ?? null,
                session_number: row.session_number ?? null,
                timestamp: row.timestamp ?? null,
                excerpt: text.substring(from, from + windowChars),
            };
        });
    },

    getSessionErrors: (sessionId: string): { filename: string, error_log: string }[] => {
        return db.prepare(`
            SELECT filename, error_log 
            FROM recordings 
            WHERE session_id = ? AND error_log IS NOT NULL
        `).all(sessionId) as { filename: string, error_log: string }[];
    }
};
