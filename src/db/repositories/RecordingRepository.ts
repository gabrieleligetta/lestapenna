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
        return db.prepare("SELECT * FROM recordings WHERE status = 'PENDING'").all() as Recording[];
    },

    resetSessionData: (sessionId: string): Recording[] => {
        db.prepare(`
            UPDATE recordings 
            SET status = 'PENDING', transcription_text = NULL, error_log = NULL, raw_transcription_text = NULL 
            WHERE session_id = ?
        `).run(sessionId);

        db.prepare('DELETE FROM knowledge_fragments WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM location_history WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM npc_history WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM world_history WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM quests WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM inventory WHERE session_id = ?').run(sessionId);

        return recordingRepository.getSessionRecordings(sessionId);
    },

    resetUnfinishedRecordings: (sessionId: string): Recording[] => {
        db.prepare(`
             UPDATE recordings 
             SET status = 'PENDING' 
             WHERE session_id = ? AND (status = 'PROCESSING' OR status = 'FAILED')
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

    getSessionErrors: (sessionId: string): { filename: string, error_log: string }[] => {
        return db.prepare(`
            SELECT filename, error_log 
            FROM recordings 
            WHERE session_id = ? AND error_log IS NOT NULL
        `).all(sessionId) as { filename: string, error_log: string }[];
    }
};
