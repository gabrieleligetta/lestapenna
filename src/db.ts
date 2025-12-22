import Database from 'better-sqlite3';
import * as path from 'path';

// Il database verrà creato nella root del progetto
const dbPath = path.join(__dirname, '..', 'dnd_bot.db');
const db = new Database(dbPath);

// Inizializza tabella se non esiste
db.exec(`CREATE TABLE IF NOT EXISTS users (
    discord_id TEXT PRIMARY KEY,
    character_name TEXT
)`);

// Ottimizzazione per concorrenza (utile se worker e main accedono insieme)
db.pragma('journal_mode = WAL');

export const getUserName = (id: string): string | null => {
    const row = db.prepare('SELECT character_name FROM users WHERE discord_id = ?').get(id) as { character_name: string } | undefined;
    return row ? row.character_name : null;
};

export const setUserName = (id: string, name: string): void => {
    db.prepare('INSERT OR REPLACE INTO users (discord_id, character_name) VALUES (?, ?)').run(id, name);
};
