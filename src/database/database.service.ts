import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private db: Database.Database;

  onModuleInit() {
    const dbPath = path.resolve(process.cwd(), 'data', 'database.sqlite');
    const dataDir = path.dirname(dbPath);

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initializeSchema();
    this.runMigrations();
    console.log('📦 Database SQLite connesso e inizializzato.');
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

  private initializeSchema() {
    // Schema migrato dal vecchio db.ts
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER,
        is_active INTEGER DEFAULT 0,
        current_year INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        campaign_id TEXT,
        start_time INTEGER,
        end_time INTEGER,
        title TEXT,
        summary TEXT,
        session_number INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS recordings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        filename TEXT,
        filepath TEXT,
        user_id TEXT,
        timestamp INTEGER,
        status TEXT DEFAULT 'PENDING',
        macro_location TEXT,
        micro_location TEXT,
        campaign_year INTEGER,
        present_npcs TEXT,
        transcription_text TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS characters (
        user_id TEXT,
        campaign_id TEXT,
        character_name TEXT,
        class TEXT,
        race TEXT,
        description TEXT,
        PRIMARY KEY (user_id, campaign_id),
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS npcs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT,
        name TEXT,
        role TEXT,
        description TEXT,
        status TEXT DEFAULT 'ALIVE',
        last_updated INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS knowledge_fragments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT,
        session_id TEXT,
        content TEXT,
        embedding BLOB,
        tags TEXT,
        created_at INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS guild_config (
        guild_id TEXT PRIMARY KEY,
        cmd_channel_id TEXT,
        summary_channel_id TEXT
      );

      CREATE TABLE IF NOT EXISTS session_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        user_id TEXT,
        note TEXT,
        timestamp INTEGER,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS location_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT,
        session_id TEXT,
        macro_location TEXT,
        micro_location TEXT,
        timestamp INTEGER,
        session_date TEXT
      );

      CREATE TABLE IF NOT EXISTS atlas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT,
        macro_location TEXT,
        micro_location TEXT,
        description TEXT,
        last_updated INTEGER,
        UNIQUE(campaign_id, macro_location, micro_location)
      );

      CREATE TABLE IF NOT EXISTS quests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT,
        title TEXT,
        status TEXT DEFAULT 'OPEN',
        created_at INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT,
        item_name TEXT,
        quantity INTEGER DEFAULT 1,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS world_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT,
        session_id TEXT,
        description TEXT,
        event_type TEXT,
        year INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT,
        role TEXT,
        content TEXT,
        timestamp INTEGER
      );

      CREATE TABLE IF NOT EXISTS character_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT,
        character_name TEXT,
        session_id TEXT,
        event_description TEXT,
        event_type TEXT,
        timestamp INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS npc_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT,
        npc_name TEXT,
        session_id TEXT,
        event_description TEXT,
        event_type TEXT,
        timestamp INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
      );
    `);
  }

  private runMigrations() {
    // Migrazione per aggiungere transcription_text se manca (per DB esistenti)
    try {
      const tableInfo = this.db.pragma('table_info(recordings)') as any[];
      const hasCol = tableInfo.some(col => col.name === 'transcription_text');
      if (!hasCol) {
        this.db.exec('ALTER TABLE recordings ADD COLUMN transcription_text TEXT');
        console.log('📦 Migrazione: Aggiunta colonna transcription_text a recordings.');
      }
    } catch (e) {
      console.error('Errore migrazione:', e);
    }
  }
}
