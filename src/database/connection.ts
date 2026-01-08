import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const dataDir = path.join(__dirname, '..', '..', 'data'); // Adjusted path for src/database/
const dbPath = path.join(dataDir, 'dnd_bot.db');

// Assicuriamoci che la cartella esista
if (!fs.existsSync(dataDir)){
    fs.mkdirSync(dataDir, { recursive: true });
}

export const db = new Database(dbPath);

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

// --- TABELLA STORIA PERSONAGGI (BIOGRAFIA) ---
db.exec(`CREATE TABLE IF NOT EXISTS character_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    character_name TEXT NOT NULL,
    session_id TEXT,
    event_type TEXT, -- 'BACKGROUND', 'TRAUMA', 'RELATIONSHIP', 'ACHIEVEMENT', 'GOAL_CHANGE'
    description TEXT NOT NULL,
    timestamp INTEGER,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
)`);

// --- TABELLA STORIA NPC ---
db.exec(`CREATE TABLE IF NOT EXISTS npc_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    npc_name TEXT NOT NULL,
    session_id TEXT,
    event_type TEXT, -- 'REVELATION', 'BETRAYAL', 'DEATH', 'ALLIANCE', 'STATUS_CHANGE'
    description TEXT NOT NULL,
    timestamp INTEGER,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
)`);

// --- TABELLA STORIA DEL MONDO (TIMELINE) ---
db.exec(`CREATE TABLE IF NOT EXISTS world_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    session_id TEXT,
    event_type TEXT, -- 'WAR', 'POLITICS', 'DISCOVERY', 'CALAMITY', 'SUPERNATURAL', 'GENERIC'
    description TEXT NOT NULL,
    timestamp INTEGER,
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
    title TEXT,
    start_time INTEGER,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
)`);

// --- TABELLA NOTE SESSIONE ---
db.exec(`CREATE TABLE IF NOT EXISTS session_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    user_id TEXT,
    content TEXT NOT NULL,
    timestamp INTEGER,
    created_at INTEGER
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

// --- TABELLA STORICO LUOGHI ---
db.exec(`CREATE TABLE IF NOT EXISTS location_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    location TEXT,
    macro_location TEXT,
    micro_location TEXT,
    session_date TEXT,
    timestamp INTEGER,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
)`);

// --- TABELLA ATLANTE (MEMORIA LUOGHI) ---
db.exec(`CREATE TABLE IF NOT EXISTS location_atlas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    macro_location TEXT NOT NULL,
    micro_location TEXT NOT NULL,
    description TEXT,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(campaign_id, macro_location, micro_location)
)`);

// --- TABELLA DOSSIER NPC ---
db.exec(`CREATE TABLE IF NOT EXISTS npc_dossier (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    role TEXT, -- Es. "Locandiere", "Guardia", "Villain"
    description TEXT,
    status TEXT DEFAULT 'ALIVE', -- ALIVE, DEAD, MISSING
    last_seen_location TEXT, -- Link opzionale al luogo
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(campaign_id, name)
)`);

// --- TABELLA QUESTS ---
db.exec(`CREATE TABLE IF NOT EXISTS quests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    status TEXT DEFAULT 'OPEN', -- OPEN, COMPLETED, FAILED
    created_at INTEGER,
    last_updated INTEGER,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
)`);

// --- TABELLA INVENTORY ---
db.exec(`CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    acquired_at INTEGER,
    last_updated INTEGER,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
)`);

// --- MIGRATIONS ---
const migrations = [
    "ALTER TABLE sessions ADD COLUMN guild_id TEXT",
    "ALTER TABLE sessions ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL",
    "ALTER TABLE sessions ADD COLUMN session_number INTEGER",
    "ALTER TABLE sessions ADD COLUMN title TEXT",
    "ALTER TABLE knowledge_fragments ADD COLUMN start_timestamp INTEGER",
    "ALTER TABLE campaigns ADD COLUMN current_location TEXT",
    "ALTER TABLE campaigns ADD COLUMN current_macro_location TEXT",
    "ALTER TABLE campaigns ADD COLUMN current_micro_location TEXT",
    "ALTER TABLE location_history ADD COLUMN macro_location TEXT",
    "ALTER TABLE location_history ADD COLUMN micro_location TEXT",
    "ALTER TABLE location_history ADD COLUMN session_date TEXT",
    "ALTER TABLE recordings ADD COLUMN macro_location TEXT",
    "ALTER TABLE recordings ADD COLUMN micro_location TEXT",
    "ALTER TABLE knowledge_fragments ADD COLUMN macro_location TEXT",
    "ALTER TABLE knowledge_fragments ADD COLUMN micro_location TEXT",
    "ALTER TABLE knowledge_fragments ADD COLUMN associated_npcs TEXT",
    "ALTER TABLE location_history ADD COLUMN session_id TEXT",
    "ALTER TABLE session_notes ADD COLUMN macro_location TEXT",
    "ALTER TABLE session_notes ADD COLUMN micro_location TEXT",
    "ALTER TABLE recordings ADD COLUMN present_npcs TEXT",
    "ALTER TABLE recordings ADD COLUMN character_name_snapshot TEXT",
    // NUOVE COLONNE PER TIMELINE
    "ALTER TABLE campaigns ADD COLUMN current_year INTEGER",
    "ALTER TABLE world_history ADD COLUMN year INTEGER",
    // NUOVA COLONNA PER ANNO REGISTRAZIONE
    "ALTER TABLE recordings ADD COLUMN year INTEGER",
    // NUOVA COLONNA PER START TIME SESSIONE
    "ALTER TABLE sessions ADD COLUMN start_time INTEGER"
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
db.exec(`CREATE INDEX IF NOT EXISTS idx_session_notes_session ON session_notes (session_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_location_history_campaign ON location_history (campaign_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_location_atlas_campaign ON location_atlas (campaign_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_npc_dossier_campaign ON npc_dossier (campaign_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_quests_campaign ON quests (campaign_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_campaign ON inventory (campaign_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_char_history_name ON character_history (campaign_id, character_name)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_npc_history_name ON npc_history (campaign_id, npc_name)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_world_history_campaign ON world_history (campaign_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_world_history_year ON world_history (year)`);

db.pragma('journal_mode = WAL');

export const wipeDatabase = () => {
    console.log("[DB] 🧹 Svuotamento database (Sessioni) in corso...");
    db.prepare('DELETE FROM recordings').run();
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM campaigns').run();
    db.prepare('DELETE FROM characters').run();
    db.prepare('DELETE FROM knowledge_fragments').run();
    db.prepare('DELETE FROM chat_history').run();
    db.prepare('DELETE FROM session_notes').run();
    db.prepare('DELETE FROM location_history').run();
    db.prepare('DELETE FROM location_atlas').run();
    db.prepare('DELETE FROM npc_dossier').run();
    db.prepare('DELETE FROM quests').run();
    db.prepare('DELETE FROM inventory').run();
    db.prepare('DELETE FROM character_history').run();
    db.prepare('DELETE FROM npc_history').run();
    db.prepare('DELETE FROM world_history').run();
    db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('recordings', 'sessions', 'campaigns', 'characters', 'knowledge_fragments', 'chat_history', 'session_notes', 'location_history', 'location_atlas', 'npc_dossier', 'quests', 'inventory', 'character_history', 'npc_history', 'world_history')").run();
    db.exec('VACUUM');
    console.log("[DB] ✅ Database sessioni svuotato.");
};
