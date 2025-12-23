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

// Creiamo la tabella con i nuovi campi
db.exec(`CREATE TABLE IF NOT EXISTS users (
    discord_id TEXT PRIMARY KEY,
    character_name TEXT,
    race TEXT,
    class TEXT,
    description TEXT
)`);

// MIGRATION "SPORCA" (Per non farti cancellare il DB a mano se esiste già)
try { db.exec("ALTER TABLE users ADD COLUMN race TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN class TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN description TEXT"); } catch (e) {}

db.pragma('journal_mode = WAL');

export interface UserProfile {
    character_name: string | null;
    race: string | null;
    class: string | null;
    description: string | null;
}

export const getUserProfile = (id: string): UserProfile => {
    const row = db.prepare('SELECT character_name, race, class, description FROM users WHERE discord_id = ?').get(id) as UserProfile | undefined;
    return row || { character_name: null, race: null, class: null, description: null };
};

// Manteniamo la vecchia funzione per compatibilità, ma usiamo la nuova logica interna se serve, 
// oppure la lasciamo come wrapper semplice per getUserProfile
export const getUserName = (id: string): string | null => {
    const p = getUserProfile(id);
    return p.character_name;
};

export const setUserName = (id: string, name: string): void => {
    updateUserField(id, 'character_name', name);
};

export const updateUserField = (id: string, field: 'character_name' | 'race' | 'class' | 'description', value: string): void => {
    // Upsert logic: inserisce se non esiste, aggiorna se esiste
    const exists = db.prepare('SELECT 1 FROM users WHERE discord_id = ?').get(id);
    
    if (exists) {
        db.prepare(`UPDATE users SET ${field} = ? WHERE discord_id = ?`).run(value, id);
    } else {
        // Se è un nuovo utente, dobbiamo fare una insert specifica
        db.prepare('INSERT INTO users (discord_id) VALUES (?)').run(id);
        db.prepare(`UPDATE users SET ${field} = ? WHERE discord_id = ?`).run(value, id);
    }
};
