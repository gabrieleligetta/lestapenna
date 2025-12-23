import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const dataDir = path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'dnd_bot.db');

// Assicuriamoci che la cartella esista
if (!fs.existsSync(dataDir)){
    fs.mkdirSync(dataDir);
}

const db = new Database(dbPath);

// --- TABELLA UTENTI ---
db.exec(`CREATE TABLE IF NOT EXISTS users (
    discord_id TEXT PRIMARY KEY,
    character_name TEXT,
    race TEXT,
    class TEXT,
    description TEXT
)`);

// --- TABELLA REGISTRAZIONI ---
db.exec(`CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    user_id TEXT,
    timestamp INTEGER,
    status TEXT DEFAULT 'PENDING', 
    transcription_text TEXT,
    error_log TEXT
)`);

// --- TABELLA SESSIONI ---
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    session_number INTEGER
)`);

// Indici per velocizzare le ricerche
db.exec(`CREATE INDEX IF NOT EXISTS idx_recordings_session_id ON recordings (session_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings (status)`);

// Migration "SPORCA" Raggruppata
const migrations = [
    "ALTER TABLE users ADD COLUMN race TEXT",
    "ALTER TABLE users ADD COLUMN class TEXT",
    "ALTER TABLE users ADD COLUMN description TEXT",
    "ALTER TABLE recordings ADD COLUMN error_log TEXT",
    "CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, session_number INTEGER)"
];

for (const m of migrations) {
    try { db.exec(m); } catch (e) { /* Ignora se la colonna esiste già */ }
}

db.pragma('journal_mode = WAL');

// --- INTERFACCE ---

export interface UserProfile {
    character_name: string | null;
    race: string | null;
    class: string | null;
    description: string | null;
}

export interface Recording {
    id: number;
    session_id: string;
    filename: string;
    filepath: string;
    user_id: string;
    timestamp: number;
    status: string;
    transcription_text: string | null;
}

export interface SessionSummary {
    session_id: string;
    start_time: number;
    fragments: number;
}

// --- FUNZIONI UTENTI ---

export const getUserProfile = (id: string): UserProfile => {
    const row = db.prepare('SELECT character_name, race, class, description FROM users WHERE discord_id = ?').get(id) as UserProfile | undefined;
    return row || { character_name: null, race: null, class: null, description: null };
};

export const getUserName = (id: string): string | null => {
    const p = getUserProfile(id);
    return p.character_name;
};

export const setUserName = (id: string, name: string): void => {
    updateUserField(id, 'character_name', name);
};

export const updateUserField = (id: string, field: 'character_name' | 'race' | 'class' | 'description', value: string): void => {
    const exists = db.prepare('SELECT 1 FROM users WHERE discord_id = ?').get(id);
    
    if (exists) {
        db.prepare(`UPDATE users SET ${field} = ? WHERE discord_id = ?`).run(value, id);
    } else {
        db.prepare('INSERT INTO users (discord_id) VALUES (?)').run(id);
        db.prepare(`UPDATE users SET ${field} = ? WHERE discord_id = ?`).run(value, id);
    }
};

// --- FUNZIONI REGISTRAZIONI ---

export const addRecording = (sessionId: string, filename: string, filepath: string, userId: string, timestamp: number) => {
    return db.prepare('INSERT INTO recordings (session_id, filename, filepath, user_id, timestamp) VALUES (?, ?, ?, ?, ?)').run(sessionId, filename, filepath, userId, timestamp);
};

export const getSessionRecordings = (sessionId: string): Recording[] => {
    return db.prepare('SELECT * FROM recordings WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId) as Recording[];
};

export const getRecording = (filename: string): Recording | undefined => {
    return db.prepare('SELECT * FROM recordings WHERE filename = ?').get(filename) as Recording | undefined;
};

export const updateRecordingStatus = (filename: string, status: string, text: string | null = null, error: string | null = null) => {
    if (text !== null) {
        db.prepare('UPDATE recordings SET status = ?, transcription_text = ? WHERE filename = ?').run(status, text, filename);
    } else if (error !== null) {
        db.prepare('UPDATE recordings SET status = ?, error_log = ? WHERE filename = ?').run(status, error, filename);
    } else {
        db.prepare('UPDATE recordings SET status = ? WHERE filename = ?').run(status, filename);
    }
};

/**
 * Recupera tutte le registrazioni che non sono ancora state trascritte.
 * Utile al riavvio del bot per riprendere il lavoro.
 */
export const getUnprocessedRecordings = () => {
    return db.prepare(`
        SELECT * FROM recordings 
        WHERE status IN ('PENDING', 'SECURED', 'QUEUED', 'PROCESSING')
    `).all() as Recording[];
};

/**
 * Resetta lo stato di una sessione per permettere la rielaborazione.
 * Riporta tutti i file a 'PENDING' e cancella le trascrizioni precedenti.
 */
export const resetSessionData = (sessionId: string): Recording[] => {
    // 1. Reset dei campi
    db.prepare(`
        UPDATE recordings 
        SET status = 'PENDING', transcription_text = NULL, error_log = NULL 
        WHERE session_id = ?
    `).run(sessionId);

    // 2. Ritorna i file pronti per essere riaccodati
    return getSessionRecordings(sessionId);
};

/**
 * Riporta allo stato PENDING solo i file che erano in fase di elaborazione
 * o in coda, evitando di toccare quelli già completati o scartati.
 * Utile per il recovery automatico al riavvio.
 */
export const resetUnfinishedRecordings = (sessionId: string): Recording[] => {
    // 1. Riporta a PENDING i file che erano "in volo" (interrotti dal crash)
    db.prepare(`
        UPDATE recordings 
        SET status = 'PENDING', error_log = NULL 
        WHERE session_id = ? AND status IN ('QUEUED', 'PROCESSING')
    `).run(sessionId);

    // 2. Recupera tutti i file che risultano da processare per questa sessione
    // (Inclusi quelli che erano già PENDING)
    return db.prepare(`
        SELECT * FROM recordings 
        WHERE session_id = ? AND status IN ('PENDING', 'SECURED', 'QUEUED', 'PROCESSING')
    `).all(sessionId) as Recording[];
};

// --- NUOVE FUNZIONI PER IL BARDO ---

export const getSessionTranscript = (sessionId: string) => {
    // Recuperiamo solo i file trascritti con successo, ordinati per tempo
    // Facciamo una JOIN per avere subito il nome del personaggio
    // AGGIUNTO: Recupero del timestamp per la diarizzazione temporale
    const rows = db.prepare(`
        SELECT r.transcription_text, r.user_id, r.timestamp, u.character_name 
        FROM recordings r
        LEFT JOIN users u ON r.user_id = u.discord_id
        WHERE r.session_id = ? AND r.status = 'PROCESSED'
        ORDER BY r.timestamp ASC
    `).all(sessionId) as Array<{ transcription_text: string, user_id: string, timestamp: number, character_name: string | null }>;

    return rows;
};

export const getSessionErrors = (sessionId: string) => {
    return db.prepare(`
        SELECT filename, error_log FROM recordings 
        WHERE session_id = ? AND status = 'ERROR'
    `).all(sessionId) as Array<{ filename: string, error_log: string | null }>;
};

export const getAvailableSessions = (): SessionSummary[] => {
    return db.prepare(`
        SELECT session_id, MIN(timestamp) as start_time, COUNT(*) as fragments 
        FROM recordings 
        GROUP BY session_id 
        ORDER BY start_time DESC 
        LIMIT 5
    `).all() as SessionSummary[];
};

/**
 * Ritorna il numero sequenziale della sessione.
 * Cerca prima nella tabella sessions, poi calcola un numero ordinale nel DB.
 */
export const getSessionNumber = (sessionId: string): number | null => {
    // 1. Controlla se abbiamo un numero assegnato esplicitamente
    const row = db.prepare('SELECT session_number FROM sessions WHERE session_id = ?').get(sessionId) as { session_number: number } | undefined;
    if (row) return row.session_number;

    // 2. Fallback: conteggio ordinale nel database
    const result = db.prepare(`
        SELECT COUNT(DISTINCT session_id) as count 
        FROM recordings 
        WHERE timestamp <= (SELECT MIN(timestamp) FROM recordings WHERE session_id = ?)
    `).get(sessionId) as { count: number };
    
    return result.count || null;
};

/**
 * Ritorna il numero della sessione SOLO se è stato impostato esplicitamente.
 */
export const getExplicitSessionNumber = (sessionId: string): number | null => {
    const row = db.prepare('SELECT session_number FROM sessions WHERE session_id = ?').get(sessionId) as { session_number: number } | undefined;
    return row ? row.session_number : null;
};

/**
 * Salva il numero di sessione assegnato.
 */
export const setSessionNumber = (sessionId: string, num: number): void => {
    db.prepare('INSERT OR REPLACE INTO sessions (session_id, session_number) VALUES (?, ?)').run(sessionId, num);
};

/**
 * Ritorna l'ID dell'utente che ha iniziato la sessione (primo frammento).
 */
export const getSessionAuthor = (sessionId: string): string | null => {
    const row = db.prepare('SELECT user_id FROM recordings WHERE session_id = ? ORDER BY timestamp ASC LIMIT 1').get(sessionId) as { user_id: string } | undefined;
    return row ? row.user_id : null;
};

/**
 * Ritorna il timestamp di inizio della sessione.
 */
export const getSessionStartTime = (sessionId: string): number | null => {
    const row = db.prepare('SELECT MIN(timestamp) as start_time FROM recordings WHERE session_id = ?').get(sessionId) as { start_time: number } | undefined;
    return row ? row.start_time : null;
};

/**
 * Tenta di trovare una session_id esistente per un timestamp dato.
 * Cerca registrazioni entro una finestra di 2 ore.
 */
export const findSessionByTimestamp = (timestamp: number): string | null => {
    const row = db.prepare(`
        SELECT session_id FROM recordings 
        WHERE timestamp > ? AND timestamp < ?
        ORDER BY ABS(timestamp - ?) ASC
        LIMIT 1
    `).get(timestamp - 7200000, timestamp + 7200000, timestamp) as { session_id: string } | undefined;
    
    return row ? row.session_id : null;
};

/**
 * Svuota tutte le tabelle del database.
 */
export const wipeDatabase = () => {
    console.log("[DB] 🧹 Svuotamento database in corso...");
    db.prepare('DELETE FROM recordings').run();
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM users').run();
    db.prepare('DELETE FROM sqlite_sequence WHERE name IN ("recordings", "sessions", "users")').run();
    db.exec('VACUUM');
    console.log("[DB] ✅ Database svuotato.");
};

export { db };
