import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private db: Database.Database;

  onModuleInit() {
    const dbPath = path.resolve(process.cwd(), 'data', 'dnd_bot.db'); // Allineato al nome legacy
    const dataDir = path.dirname(dbPath);

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initializeSchema();
    this.runMigrations();
    console.log('📦 Database SQLite connesso e inizializzato (Schema Legacy Compatible).');
  }

  onModuleDestroy() {
    if (this.db) {
      this.db.close();
      console.log('📦 Database SQLite chiuso.');
    }
  }

  getDb(): Database.Database {
    return this.db;
  }

  wipeDatabase(): void {
    if (!this.db) return;
    
    console.log("[DB] 🧹 Svuotamento database completo...");
    const tables = [
        'recordings', 'sessions', 'campaigns', 'characters', 
        'knowledge_fragments', 'chat_history', 'session_notes', 
        'location_history', 'location_atlas', 'npc_dossier', 
        'quests', 'inventory', 'character_history', 'npc_history', 'world_history',
        'config'
    ];

    this.db.transaction(() => {
        for (const table of tables) {
            try {
                this.db.prepare(`DELETE FROM ${table}`).run();
            } catch (e) {
                // Ignora se la tabella non esiste
            }
        }
        try {
            this.db.prepare("DELETE FROM sqlite_sequence").run();
        } catch (e) {}
    })();
    
    this.db.exec('VACUUM');
    console.log("[DB] ✅ Database svuotato.");
  }

  private initializeSchema() {
    // --- TABELLA CONFIGURAZIONE GLOBALE E PER GUILD ---
    this.db.exec(`CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

    // --- TABELLA CAMPAGNE ---
    this.db.exec(`CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        is_active INTEGER DEFAULT 0,
        created_at INTEGER,
        current_year INTEGER DEFAULT 0,
        current_location TEXT,
        current_macro_location TEXT,
        current_micro_location TEXT
    )`);

    // --- TABELLA PERSONAGGI ---
    this.db.exec(`CREATE TABLE IF NOT EXISTS characters (
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
    this.db.exec(`CREATE TABLE IF NOT EXISTS character_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        character_name TEXT NOT NULL,
        session_id TEXT,
        event_type TEXT, 
        description TEXT NOT NULL,
        timestamp INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);

    // --- TABELLA STORIA NPC ---
    this.db.exec(`CREATE TABLE IF NOT EXISTS npc_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        npc_name TEXT NOT NULL,
        session_id TEXT,
        event_type TEXT,
        description TEXT NOT NULL,
        timestamp INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);

    // --- TABELLA STORIA DEL MONDO (TIMELINE) ---
    this.db.exec(`CREATE TABLE IF NOT EXISTS world_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        session_id TEXT,
        event_type TEXT,
        description TEXT NOT NULL,
        timestamp INTEGER,
        year INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);

    // --- TABELLA SESSIONI ---
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        guild_id TEXT,
        campaign_id INTEGER,
        session_number INTEGER,
        title TEXT,
        summary TEXT,
        start_time INTEGER,
        end_time INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
    )`);

    // --- TABELLA REGISTRAZIONI ---
    this.db.exec(`CREATE TABLE IF NOT EXISTS recordings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        filename TEXT NOT NULL,
        filepath TEXT NOT NULL,
        user_id TEXT,
        timestamp INTEGER,
        status TEXT DEFAULT 'PENDING', 
        transcription_text TEXT,
        error_log TEXT,
        macro_location TEXT,
        micro_location TEXT,
        year INTEGER,
        present_npcs TEXT,
        character_name_snapshot TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    )`);

    // --- TABELLA NOTE SESSIONE ---
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_id TEXT,
        content TEXT NOT NULL,
        timestamp INTEGER,
        created_at INTEGER,
        macro_location TEXT,
        micro_location TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    )`);

    // --- TABELLA MEMORIA A LUNGO TERMINE (RAG) ---
    this.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_fragments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        session_id TEXT,
        content TEXT NOT NULL,
        embedding_json TEXT, -- Legacy name, kept for compatibility but might store blob if needed, or text
        embedding_model TEXT,
        vector_dimension INTEGER,
        start_timestamp INTEGER,
        created_at INTEGER,
        macro_location TEXT,
        micro_location TEXT,
        associated_npcs TEXT,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);

    // --- TABELLA CHAT HISTORY ---
    this.db.exec(`CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER
    )`);

    // --- TABELLA STORICO LUOGHI ---
    this.db.exec(`CREATE TABLE IF NOT EXISTS location_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        location TEXT,
        macro_location TEXT,
        micro_location TEXT,
        session_date TEXT,
        timestamp INTEGER,
        session_id TEXT,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);

    // --- TABELLA ATLANTE (MEMORIA LUOGHI) ---
    this.db.exec(`CREATE TABLE IF NOT EXISTS location_atlas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        macro_location TEXT NOT NULL,
        micro_location TEXT NOT NULL,
        description TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(campaign_id, macro_location, micro_location)
    )`);

    // --- TABELLA DOSSIER NPC ---
    this.db.exec(`CREATE TABLE IF NOT EXISTS npc_dossier (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        role TEXT,
        description TEXT,
        status TEXT DEFAULT 'ALIVE',
        last_seen_location TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(campaign_id, name)
    )`);

    // --- TABELLA QUESTS ---
    this.db.exec(`CREATE TABLE IF NOT EXISTS quests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT DEFAULT 'OPEN',
        created_at INTEGER,
        last_updated INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);

    // --- TABELLA INVENTORY ---
    this.db.exec(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        item_name TEXT NOT NULL,
        quantity INTEGER DEFAULT 1,
        acquired_at INTEGER,
        last_updated INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);

    // --- INDICI ---
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_recordings_session_id ON recordings (session_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings (status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_campaigns_guild ON campaigns (guild_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_campaign ON sessions (campaign_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_campaign_model ON knowledge_fragments (campaign_id, embedding_model)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_history_channel ON chat_history (channel_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_session_notes_session ON session_notes (session_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_location_history_campaign ON location_history (campaign_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_location_atlas_campaign ON location_atlas (campaign_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_npc_dossier_campaign ON npc_dossier (campaign_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_quests_campaign ON quests (campaign_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_campaign ON inventory (campaign_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_char_history_name ON character_history (campaign_id, character_name)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_npc_history_name ON npc_history (campaign_id, npc_name)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_world_history_campaign ON world_history (campaign_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_world_history_year ON world_history (year)`);
  }

  private runMigrations() {
    // Migrazioni di sicurezza per allineare eventuali DB parziali
    const migrations = [
        "ALTER TABLE sessions ADD COLUMN guild_id TEXT",
        "ALTER TABLE sessions ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL",
        "ALTER TABLE sessions ADD COLUMN session_number INTEGER",
        "ALTER TABLE sessions ADD COLUMN title TEXT",
        "ALTER TABLE sessions ADD COLUMN summary TEXT",
        "ALTER TABLE sessions ADD COLUMN start_time INTEGER",
        "ALTER TABLE sessions ADD COLUMN end_time INTEGER",
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
        "ALTER TABLE campaigns ADD COLUMN current_year INTEGER",
        "ALTER TABLE world_history ADD COLUMN year INTEGER",
        "ALTER TABLE recordings ADD COLUMN year INTEGER",
        "ALTER TABLE recordings ADD COLUMN error_log TEXT",
        "ALTER TABLE recordings ADD COLUMN transcription_text TEXT"
    ];

    for (const m of migrations) {
        try { this.db.exec(m); } catch (e) { /* Ignora se esiste già */ }
    }
  }
}
