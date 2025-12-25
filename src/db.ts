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

// --- TABELLA CONFIGURAZIONE GLOBALE E PER GUILD ---
db.exec(`CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
)`);

// --- TABELLA CAMPAGNE ---
db.exec(`CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    is_active INTEGER DEFAULT 0,
    created_at INTEGER
)`);

// --- TABELLA PERSONAGGI ---
db.exec(`CREATE TABLE IF NOT EXISTS characters (
    user_id TEXT NOT NULL,
    campaign_id INTEGER NOT NULL,
    character_name TEXT,
    race TEXT,
    class TEXT,
    description TEXT,
    PRIMARY KEY (user_id, campaign_id),
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
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
    guild_id TEXT,
    campaign_id INTEGER,
    session_number INTEGER,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
)`);

// --- TABELLA MEMORIA A LUNGO TERMINE (RAG) ---
db.exec(`CREATE TABLE IF NOT EXISTS knowledge_fragments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    session_id TEXT,
    content TEXT NOT NULL,
    embedding_json TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    vector_dimension INTEGER,
    start_timestamp INTEGER,
    created_at INTEGER,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
)`);

// --- TABELLA CHAT HISTORY ---
db.exec(`CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER
)`);

// --- MIGRATIONS ---
const migrations = [
    "ALTER TABLE sessions ADD COLUMN guild_id TEXT",
    "ALTER TABLE sessions ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL",
    "ALTER TABLE sessions ADD COLUMN session_number INTEGER",
    "ALTER TABLE knowledge_fragments ADD COLUMN start_timestamp INTEGER"
];

for (const m of migrations) {
    try { db.exec(m); } catch (e) { /* Ignora se la colonna esiste già */ }
}

// --- INDICI ---
db.exec(`CREATE INDEX IF NOT EXISTS idx_recordings_session_id ON recordings (session_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings (status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_campaigns_guild ON campaigns (guild_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_campaign ON sessions (campaign_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_campaign_model ON knowledge_fragments (campaign_id, embedding_model)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_history_channel ON chat_history (channel_id)`);

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
    campaign_name?: string;
    session_number?: number;
}

export interface Campaign {
    id: number;
    guild_id: string;
    name: string;
    is_active: number;
}

export interface KnowledgeFragment {
    id: number;
    campaign_id: number;
    session_id: string;
    content: string;
    embedding_json: string;
    embedding_model: string;
    vector_dimension: number;
    start_timestamp: number;
    created_at: number;
}

// --- FUNZIONI CONFIGURAZIONE ---

const setConfig = (key: string, value: string): void => {
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
};

const getConfig = (key: string): string | null => {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
};

export const getGuildConfig = (guildId: string, key: string): string | null => {
    return getConfig(`${guildId}_${key}`);
};

export const setGuildConfig = (guildId: string, key: string, value: string): void => {
    setConfig(`${guildId}_${key}`, value);
};

// --- FUNZIONI CAMPAGNE ---

export const createCampaign = (guildId: string, name: string): number => {
    const info = db.prepare('INSERT INTO campaigns (guild_id, name, created_at) VALUES (?, ?, ?)').run(guildId, name, Date.now());
    return info.lastInsertRowid as number;
};

export const getCampaigns = (guildId: string): Campaign[] => {
    return db.prepare('SELECT * FROM campaigns WHERE guild_id = ? ORDER BY created_at DESC').all(guildId) as Campaign[];
};

export const getActiveCampaign = (guildId: string): Campaign | undefined => {
    return db.prepare('SELECT * FROM campaigns WHERE guild_id = ? AND is_active = 1').get(guildId) as Campaign | undefined;
};

export const setActiveCampaign = (guildId: string, campaignId: number): void => {
    db.transaction(() => {
        db.prepare('UPDATE campaigns SET is_active = 0 WHERE guild_id = ?').run(guildId);
        db.prepare('UPDATE campaigns SET is_active = 1 WHERE id = ? AND guild_id = ?').run(campaignId, guildId);
    })();
};

export const getCampaignById = (id: number): Campaign | undefined => {
    return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as Campaign | undefined;
};

// --- FUNZIONI PERSONAGGI (CONTEXT AWARE) ---

export const getUserProfile = (userId: string, campaignId: number): UserProfile => {
    const row = db.prepare('SELECT character_name, race, class, description FROM characters WHERE user_id = ? AND campaign_id = ?').get(userId, campaignId) as UserProfile | undefined;
    return row || { character_name: null, race: null, class: null, description: null };
};

export const getUserName = (userId: string, campaignId: number): string | null => {
    const p = getUserProfile(userId, campaignId);
    return p.character_name;
};

export const getCampaignCharacters = (campaignId: number): UserProfile[] => {
    return db.prepare('SELECT character_name, race, class, description FROM characters WHERE campaign_id = ?').all(campaignId) as UserProfile[];
};

export const updateUserCharacter = (userId: string, campaignId: number, field: 'character_name' | 'race' | 'class' | 'description', value: string): void => {
    const exists = db.prepare('SELECT 1 FROM characters WHERE user_id = ? AND campaign_id = ?').get(userId, campaignId);

    if (exists) {
        db.prepare(`UPDATE characters SET ${field} = ? WHERE user_id = ? AND campaign_id = ?`).run(value, userId, campaignId);
    } else {
        db.prepare('INSERT INTO characters (user_id, campaign_id) VALUES (?, ?)').run(userId, campaignId);
        db.prepare(`UPDATE characters SET ${field} = ? WHERE user_id = ? AND campaign_id = ?`).run(value, userId, campaignId);
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

export const getUnprocessedRecordings = () => {
    return db.prepare(`
        SELECT * FROM recordings 
        WHERE status IN ('PENDING', 'SECURED', 'QUEUED', 'PROCESSING')
    `).all() as Recording[];
};

export const resetSessionData = (sessionId: string): Recording[] => {
    db.prepare(`
        UPDATE recordings 
        SET status = 'PENDING', transcription_text = NULL, error_log = NULL 
        WHERE session_id = ?
    `).run(sessionId);
    return getSessionRecordings(sessionId);
};

export const resetUnfinishedRecordings = (sessionId: string): Recording[] => {
    db.prepare(`
        UPDATE recordings 
        SET status = 'PENDING', error_log = NULL 
        WHERE session_id = ? AND status IN ('QUEUED', 'PROCESSING')
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
            SELECT r.transcription_text, r.user_id, r.timestamp, NULL as character_name
            FROM recordings r
            WHERE r.session_id = ? AND r.status = 'PROCESSED'
            ORDER BY r.timestamp ASC
        `).all(sessionId) as Array<{ transcription_text: string, user_id: string, timestamp: number, character_name: string | null }>;
    }

    const rows = db.prepare(`
        SELECT r.transcription_text, r.user_id, r.timestamp, c.character_name 
        FROM recordings r
        LEFT JOIN characters c ON r.user_id = c.user_id AND c.campaign_id = ?
        WHERE r.session_id = ? AND r.status = 'PROCESSED'
        ORDER BY r.timestamp ASC
    `).all(session.campaign_id, sessionId) as Array<{ transcription_text: string, user_id: string, timestamp: number, character_name: string | null }>;

    return rows;
};

export const getSessionErrors = (sessionId: string) => {
    return db.prepare(`
        SELECT filename, error_log FROM recordings 
        WHERE session_id = ? AND status = 'ERROR'
    `).all(sessionId) as Array<{ filename: string, error_log: string | null }>;
};

export const getAvailableSessions = (guildId?: string, campaignId?: number): SessionSummary[] => {
    let query = `
        SELECT s.session_id, MIN(r.timestamp) as start_time, COUNT(r.id) as fragments, c.name as campaign_name, s.session_number
        FROM sessions s
        JOIN recordings r ON s.session_id = r.session_id
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

    query += ` GROUP BY s.session_id ORDER BY start_time DESC LIMIT 5`;

    return db.prepare(query).all(...params) as SessionSummary[];
};

export const getExplicitSessionNumber = (sessionId: string): number | null => {
    const row = db.prepare('SELECT session_number FROM sessions WHERE session_id = ?').get(sessionId) as { session_number: number } | undefined;
    return row ? row.session_number : null;
};

export const setSessionNumber = (sessionId: string, num: number): void => {
    db.prepare('UPDATE sessions SET session_number = ? WHERE session_id = ?').run(num, sessionId);
};

export const createSession = (sessionId: string, guildId: string, campaignId: number): void => {
    db.prepare('INSERT INTO sessions (session_id, guild_id, campaign_id) VALUES (?, ?, ?)').run(sessionId, guildId, campaignId);
};

export const getSessionAuthor = (sessionId: string): string | null => {
    const row = db.prepare('SELECT user_id FROM recordings WHERE session_id = ? ORDER BY timestamp ASC LIMIT 1').get(sessionId) as { user_id: string } | undefined;
    return row ? row.user_id : null;
};

export const getSessionStartTime = (sessionId: string): number | null => {
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

// --- FUNZIONI KNOWLEDGE BASE (RAG) ---

export const insertKnowledgeFragment = (campaignId: number, sessionId: string, content: string, embedding: number[], model: string, startTimestamp: number = 0) => {
    db.prepare(`
        INSERT INTO knowledge_fragments (campaign_id, session_id, content, embedding_json, embedding_model, vector_dimension, start_timestamp, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(campaignId, sessionId, content, JSON.stringify(embedding), model, embedding.length, startTimestamp, Date.now());
};

export const getKnowledgeFragments = (campaignId: number, model: string): KnowledgeFragment[] => {
    return db.prepare(`
        SELECT * FROM knowledge_fragments
        WHERE campaign_id = ? AND embedding_model = ?
    `).all(campaignId, model) as KnowledgeFragment[];
};

export const deleteSessionKnowledge = (sessionId: string, model: string) => {
    db.prepare(`DELETE FROM knowledge_fragments WHERE session_id = ? AND embedding_model = ?`).run(sessionId, model);
};

// --- FUNZIONI CHAT HISTORY ---

export const addChatMessage = (channelId: string, role: 'user' | 'assistant', content: string) => {
    db.prepare('INSERT INTO chat_history (channel_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(channelId, role, content, Date.now());
};

export const getChatHistory = (channelId: string, limit: number = 10): { role: 'user' | 'assistant', content: string }[] => {
    const rows = db.prepare('SELECT role, content FROM chat_history WHERE channel_id = ? ORDER BY timestamp DESC LIMIT ?').all(channelId, limit) as { role: 'user' | 'assistant', content: string }[];
    return rows.reverse();
};

export const wipeDatabase = () => {
    console.log("[DB] 🧹 Svuotamento database (Sessioni) in corso...");
    db.prepare('DELETE FROM recordings').run();
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM campaigns').run();
    db.prepare('DELETE FROM characters').run();
    db.prepare('DELETE FROM knowledge_fragments').run();
    db.prepare('DELETE FROM chat_history').run();
    db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('recordings', 'sessions', 'campaigns', 'characters', 'knowledge_fragments', 'chat_history')").run();
    db.exec('VACUUM');
    console.log("[DB] ✅ Database sessioni svuotato.");
};

export { db };
