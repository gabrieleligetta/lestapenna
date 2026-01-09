import { db } from '../connection';
import { Recording, SessionSummary, SessionNote } from '../types';
import { getCampaignLocationById } from './campaign';

// --- FUNZIONI REGISTRAZIONI ---

export const addRecording = (sessionId: string, filename: string, filepath: string, userId: string, timestamp: number, macro: string | null = null, micro: string | null = null, year: number | null = null) => {
    return db.prepare('INSERT INTO recordings (session_id, filename, filepath, user_id, timestamp, macro_location, micro_location, year) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(sessionId, filename, filepath, userId, timestamp, macro, micro, year);
};

export const getSessionRecordings = (sessionId: string): Recording[] => {
    return db.prepare('SELECT * FROM recordings WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId) as Recording[];
};

export const getRecording = (filename: string): Recording | undefined => {
    return db.prepare('SELECT * FROM recordings WHERE filename = ?').get(filename) as Recording | undefined;
};

export const updateRecordingStatus = (filename: string, status: string, text: string | null = null, error: string | null = null, macro: string | null = null, micro: string | null = null, npcs: string[] = [], characterNameSnapshot: string | null = null) => {
    if (text !== null) {
        const npcString = npcs.length > 0 ? npcs.join(',') : null;
        db.prepare('UPDATE recordings SET status = ?, transcription_text = ?, macro_location = ?, micro_location = ?, present_npcs = ?, character_name_snapshot = ? WHERE filename = ?').run(status, text, macro, micro, npcString, characterNameSnapshot, filename);
    } else if (error !== null) {
        db.prepare('UPDATE recordings SET status = ?, error_log = ? WHERE filename = ?').run(status, error, filename);
    } else {
        db.prepare('UPDATE recordings SET status = ? WHERE filename = ?').run(status, filename);
    }
};

export const getUnprocessedRecordings = () => {
    return db.prepare(`
        SELECT * FROM recordings 
        WHERE status IN ('PENDING', 'SECURED', 'QUEUED', 'PROCESSING', 'TRANSCRIBED')
    `).all() as Recording[];
};

export const resetSessionData = (sessionId: string): Recording[] => {
    // 1. PULIZIA RAG (Memoria)
    db.prepare('DELETE FROM knowledge_fragments WHERE session_id = ?').run(sessionId);
    console.log(`[DB] 🧠 Memoria RAG pulita per sessione ${sessionId}`);

    // 2. PULIZIA STORIA VIAGGI
    try {
        db.prepare('DELETE FROM location_history WHERE session_id = ?').run(sessionId);
        console.log(`[DB] 🗺️ Storia viaggi pulita per sessione ${sessionId}`);
    } catch (e) {
        // Ignora se la colonna non esiste ancora
    }

    // 3. RESET STATO FILE
    db.prepare(`
        UPDATE recordings 
        SET status = 'PENDING', transcription_text = NULL, error_log = NULL 
        WHERE session_id = ?
    `).run(sessionId);
    return getSessionRecordings(sessionId);
};

export const resetUnfinishedRecordings = (sessionId: string): Recording[] => {
    // Resetta anche quelli rimasti in TRANSCRIBED (che non hanno completato la correzione)
    db.prepare(`
        UPDATE recordings 
        SET status = 'PENDING', error_log = NULL 
        WHERE session_id = ? AND status IN ('QUEUED', 'PROCESSING', 'TRANSCRIBED')
    `).run(sessionId);

    return db.prepare(`
        SELECT * FROM recordings 
        WHERE session_id = ? AND status IN ('PENDING', 'SECURED', 'QUEUED', 'PROCESSING')
    `).all(sessionId) as Recording[];
};

// --- FUNZIONI BARDO & SESSIONI ---

export const getSessionTranscript = (sessionId: string) => {
    const session = db.prepare('SELECT campaign_id FROM sessions WHERE session_id = ?').get(sessionId) as { campaign_id: number } | undefined;

    if (!session) {
        return db.prepare(`
            SELECT r.transcription_text, r.user_id, r.timestamp, COALESCE(r.character_name_snapshot, 'Sconosciuto') as character_name, r.macro_location, r.micro_location, r.present_npcs
            FROM recordings r
            WHERE r.session_id = ? AND r.status = 'PROCESSED'
            ORDER BY r.timestamp ASC
        `).all(sessionId) as Array<{ transcription_text: string, user_id: string, timestamp: number, character_name: string | null, macro_location: string | null, micro_location: string | null, present_npcs: string | null }>;
    }

    const rows = db.prepare(`
        SELECT r.transcription_text, r.user_id, r.timestamp, COALESCE(r.character_name_snapshot, c.character_name) as character_name, r.macro_location, r.micro_location, r.present_npcs
        FROM recordings r
        LEFT JOIN characters c ON r.user_id = c.user_id AND c.campaign_id = ?
        WHERE r.session_id = ? AND r.status = 'PROCESSED'
        ORDER BY r.timestamp ASC
    `).all(session.campaign_id, sessionId) as Array<{ transcription_text: string, user_id: string, timestamp: number, character_name: string | null, macro_location: string | null, micro_location: string | null, present_npcs: string | null }>;

    return rows;
};

export const getSessionErrors = (sessionId: string) => {
    return db.prepare(`
        SELECT filename, error_log FROM recordings 
        WHERE session_id = ? AND status = 'ERROR'
    `).all(sessionId) as Array<{ filename: string, error_log: string | null }>;
};

export const getAvailableSessions = (guildId?: string, campaignId?: number, limit: number = 5): SessionSummary[] => {
    let query = `
        SELECT s.session_id, COALESCE(s.start_time, MIN(r.timestamp)) as start_time, COUNT(r.id) as fragments, c.name as campaign_name, s.session_number, s.title
        FROM sessions s
        LEFT JOIN recordings r ON s.session_id = r.session_id
        LEFT JOIN campaigns c ON s.campaign_id = c.id
    `;

    const params: any[] = [];
    const conditions: string[] = [];

    if (guildId) {
        conditions.push("s.guild_id = ?");
        params.push(guildId);
    }
    if (campaignId) {
        conditions.push("s.campaign_id = ?");
        params.push(campaignId);
    }

    if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
    }

    query += ` GROUP BY s.session_id ORDER BY start_time DESC`;

    if (limit > 0) {
        query += ` LIMIT ?`;
        params.push(limit);
    }

    return db.prepare(query).all(...params) as SessionSummary[];
};

export const getExplicitSessionNumber = (sessionId: string): number | null => {
    const row = db.prepare('SELECT session_number FROM sessions WHERE session_id = ?').get(sessionId) as { session_number: number } | undefined;
    return row ? row.session_number : null;
};

export const setSessionNumber = (sessionId: string, num: number): void => {
    db.prepare('UPDATE sessions SET session_number = ? WHERE session_id = ?').run(num, sessionId);
};

export const updateSessionTitle = (sessionId: string, title: string): void => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run(title, sessionId);
};

export const createSession = (sessionId: string, guildId: string, campaignId: number | null, startTime?: number): void => {
    db.prepare('INSERT OR IGNORE INTO sessions (session_id, guild_id, campaign_id, start_time) VALUES (?, ?, ?, ?)').run(sessionId, guildId, campaignId, startTime || null);
};

export const getSessionAuthor = (sessionId: string): string | null => {
    const row = db.prepare('SELECT user_id FROM recordings WHERE session_id = ? ORDER BY timestamp ASC LIMIT 1').get(sessionId) as { user_id: string } | undefined;
    return row ? row.user_id : null;
};

export const getSessionStartTime = (sessionId: string): number | null => {
    // Prima prova a prendere lo start_time esplicito dalla tabella sessions
    const sessionRow = db.prepare('SELECT start_time FROM sessions WHERE session_id = ?').get(sessionId) as { start_time: number } | undefined;
    if (sessionRow && sessionRow.start_time) return sessionRow.start_time;

    // Fallback: prendi il timestamp della prima registrazione
    const row = db.prepare('SELECT MIN(timestamp) as start_time FROM recordings WHERE session_id = ?').get(sessionId) as { start_time: number } | undefined;
    return row ? row.start_time : null;
};

export const getSessionCampaignId = (sessionId: string): number | undefined => {
    const row = db.prepare('SELECT campaign_id FROM sessions WHERE session_id = ?').get(sessionId) as { campaign_id: number } | undefined;
    return row?.campaign_id;
};

export const findSessionByTimestamp = (timestamp: number): string | null => {
    const row = db.prepare(`
        SELECT session_id FROM recordings 
        WHERE timestamp > ? AND timestamp < ?
        ORDER BY ABS(timestamp - ?) ASC
        LIMIT 1
    `).get(timestamp - 7200000, timestamp + 7200000, timestamp) as { session_id: string } | undefined;

    return row ? row.session_id : null;
};

// --- FUNZIONI NOTE SESSIONE ---

export const addSessionNote = (sessionId: string, user_id: string, content: string, timestamp: number) => {
    // Recupera luogo attuale
    const session = db.prepare('SELECT campaign_id FROM sessions WHERE session_id = ?').get(sessionId) as {campaign_id: number};
    let macro = null, micro = null;

    if (session) {
        const loc = getCampaignLocationById(session.campaign_id);
        macro = loc?.macro;
        micro = loc?.micro;
    }

    db.prepare(`
        INSERT INTO session_notes (session_id, user_id, content, timestamp, created_at, macro_location, micro_location) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, user_id, content, timestamp, Date.now(), macro, micro);
};

export const getSessionNotes = (sessionId: string): SessionNote[] => {
    return db.prepare('SELECT * FROM session_notes WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId) as SessionNote[];
};

// --- REPORTING HELPERS ---

export const getSessionTravelLog = (sessionId: string) => {
    return db.prepare(`
        SELECT macro_location, micro_location, timestamp 
        FROM location_history 
        WHERE session_id = ? 
        ORDER BY timestamp ASC
    `).all(sessionId) as { macro_location: string, micro_location: string, timestamp: number }[];
};

export const getSessionEncounteredNPCs = (sessionId: string) => {
    // 1. Estrai tutte le stringhe grezze 'present_npcs' dalle registrazioni
    const rows = db.prepare(`
        SELECT DISTINCT present_npcs 
        FROM recordings 
        WHERE session_id = ? AND present_npcs IS NOT NULL
    `).all(sessionId) as { present_npcs: string }[];

    // 2. Unisci e pulisci i nomi
    const uniqueNames = new Set<string>();
    rows.forEach(row => {
        if (row.present_npcs) {
            row.present_npcs.split(',').forEach(n => {
                const clean = n.trim();
                if (clean) uniqueNames.add(clean);
            });
        }
    });

    if (uniqueNames.size === 0) return [];

    // 3. Recupera i dettagli dal Dossier per questi nomi (case insensitive)
    const namesArray = Array.from(uniqueNames);
    const placeholders = namesArray.map(() => 'lower(name) = lower(?)').join(' OR ');

    if (!placeholders) return [];

    const details = db.prepare(`
        SELECT name, role, description, status 
        FROM npc_dossier 
        WHERE campaign_id = (SELECT campaign_id FROM sessions WHERE session_id = ?)
        AND (${placeholders})
    `).all(sessionId, ...namesArray) as { name: string, role: string, description: string, status: string }[];

    return details;
};
