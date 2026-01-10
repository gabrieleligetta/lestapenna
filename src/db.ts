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
    // 🆕 NUOVO CAMPO PER TRASCRIZIONI GREZZE
    "ALTER TABLE recordings ADD COLUMN raw_transcription_text TEXT"
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
db.exec(`CREATE INDEX IF NOT EXISTS idx_world_history_year ON world_history (year)`); // Nuovo indice per ordinamento

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
    raw_transcription_text?: string | null; // 🆕 Grezzo di Whisper
    macro_location?: string | null;
    micro_location?: string | null;
    present_npcs?: string | null;
    character_name_snapshot?: string | null;
    year?: number | null;
}

export interface SessionSummary {
    session_id: string;
    start_time: number;
    fragments: number;
    campaign_name?: string;
    session_number?: number;
    title?: string;
}

export interface Campaign {
    id: number;
    guild_id: string;
    name: string;
    is_active: number;
    current_location?: string;
    current_macro_location?: string;
    current_micro_location?: string;
    current_year?: number; // NUOVO
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
    macro_location?: string | null;
    micro_location?: string | null;
    associated_npcs?: string | null;
}

export interface SessionNote {
    id: number;
    session_id: string;
    user_id: string;
    content: string;
    timestamp: number;
    created_at: number;
    macro_location?: string | null;
    micro_location?: string | null;
}

export interface LocationState {
    macro: string | null;
    micro: string | null;
}

export interface NpcEntry {
    id: number;
    campaign_id: number;
    name: string;
    role: string | null;
    description: string | null;
    status: string;
    last_seen_location: string | null;
    last_updated: string;
}

export interface Quest {
    id: number;
    campaign_id: number;
    title: string;
    status: 'OPEN' | 'COMPLETED' | 'FAILED';
    created_at: number;
    last_updated: number;
}

export interface InventoryItem {
    id: number;
    campaign_id: number;
    item_name: string;
    quantity: number;
    acquired_at: number;
    last_updated: number;
}

// Definiamo bene cosa contiene lo snapshot
export interface CampaignSnapshot {
    characters: any[];
    quests: any[];
    location: { macro: string | null; micro: string | null } | null;
    atlasDesc: string | null;
    // Queste restano per compatibilità o per uso rapido nel prompt
    pc_context: string;
    quest_context: string;
    location_context: string;
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

export const updateCampaignLocation = (guildId: string, location: string): void => {
    const campaign = getActiveCampaign(guildId);
    if (campaign) {
        db.transaction(() => {
            db.prepare('UPDATE campaigns SET current_location = ? WHERE id = ?').run(location, campaign.id);
            db.prepare('INSERT INTO location_history (campaign_id, location, timestamp) VALUES (?, ?, ?)').run(campaign.id, location, Date.now());
        })();
    }
};

export const setCampaignYear = (campaignId: number, year: number): void => {
    db.prepare('UPDATE campaigns SET current_year = ? WHERE id = ?').run(year, campaignId);
    console.log(`[DB] 📅 Anno campagna ${campaignId} impostato a: ${year}`);
};

// --- NUOVE FUNZIONI LUOGO (MACRO/MICRO) ---

export const updateLocation = (campaignId: number, macro: string | null, micro: string | null, sessionId?: string): void => {
    // 1. Aggiorna lo stato corrente della campagna
    const current = getCampaignLocationById(campaignId);
    
    // Se è identico, non facciamo nulla (evita spam nella history)
    if (current && current.macro === macro && current.micro === micro) return;

    const stmt = db.prepare(`
        UPDATE campaigns 
        SET current_macro_location = COALESCE(?, current_macro_location), 
            current_micro_location = ? 
        WHERE id = ?
    `);
    // Nota: Micro può essere resettato, Macro tendiamo a mantenerlo se non specificato
    stmt.run(macro, micro, campaignId);

    // 2. Aggiungi alla cronologia
    let legacyLocation = "Sconosciuto";
    if (macro && micro) legacyLocation = `${macro} | ${micro}`;
    else if (macro) legacyLocation = macro;
    else if (micro) legacyLocation = micro;

    const historyStmt = db.prepare(`
        INSERT INTO location_history (campaign_id, location, macro_location, micro_location, session_date, timestamp, session_id)
        VALUES (?, ?, ?, ?, date('now'), ?, ?)
    `);
    historyStmt.run(campaignId, legacyLocation, macro, micro, Date.now(), sessionId || null);
    
    console.log(`[DB] 🗺️ Luogo aggiornato: [${macro}] - (${micro})`);
};

export const getCampaignLocation = (guildId: string): LocationState | null => {
    const row = db.prepare(`
        SELECT current_macro_location as macro, current_micro_location as micro 
        FROM campaigns 
        WHERE guild_id = ? AND is_active = 1
    `).get(guildId) as LocationState | undefined;
    return row || null;
};

export const getCampaignLocationById = (campaignId: number): LocationState | null => {
    const row = db.prepare(`
        SELECT current_macro_location as macro, current_micro_location as micro 
        FROM campaigns 
        WHERE id = ?
    `).get(campaignId) as LocationState | undefined;
    return row || null;
};

export const getLocationHistory = (guildId: string) => {
    return db.prepare(`
        SELECT h.macro_location, h.micro_location, h.timestamp, h.session_date 
        FROM location_history h
        JOIN campaigns c ON h.campaign_id = c.id
        WHERE c.guild_id = ? AND c.is_active = 1
        ORDER BY h.timestamp DESC
        LIMIT 20
    `).all(guildId);
};

// --- FUNZIONI ATLANTE (MEMORIA LUOGHI) ---

export const getAtlasEntry = (campaignId: number, macro: string, micro: string): string | null => {
    // Normalizziamo le stringhe per evitare duplicati "Taverna" vs "taverna"
    const row = db.prepare(`
        SELECT description FROM location_atlas 
        WHERE campaign_id = ? 
        AND lower(macro_location) = lower(?) 
        AND lower(micro_location) = lower(?)
    `).get(campaignId, macro, micro) as { description: string } | undefined;

    return row ? row.description : null;
};

export const updateAtlasEntry = (campaignId: number, macro: string, micro: string, newDescription: string) => {
    // Sanitize: Force string if object is passed (AI hallucination fix)
    const safeDesc = (typeof newDescription === 'object') ? JSON.stringify(newDescription) : String(newDescription);

    // Upsert: Inserisci o Aggiorna se esiste
    db.prepare(`
        INSERT INTO location_atlas (campaign_id, macro_location, micro_location, description, last_updated)
        VALUES ($campaignId, $macro, $micro, $desc, CURRENT_TIMESTAMP)
        ON CONFLICT(campaign_id, macro_location, micro_location) 
        DO UPDATE SET description = $desc, last_updated = CURRENT_TIMESTAMP
    `).run({ campaignId, macro, micro, desc: safeDesc });
    
    console.log(`[Atlas] 📖 Aggiornata voce per: ${macro} - ${micro}`);
};

// --- FUNZIONI DOSSIER NPC ---

export const updateNpcEntry = (campaignId: number, name: string, description: string, role?: string, status?: string) => {
    // Sanitize: Force string if object is passed
    const safeDesc = (typeof description === 'object') ? JSON.stringify(description) : String(description);

    // Upsert intelligente
    db.prepare(`
        INSERT INTO npc_dossier (campaign_id, name, description, role, status, last_updated)
        VALUES ($campaignId, $name, $description, $role, $status, CURRENT_TIMESTAMP)
        ON CONFLICT(campaign_id, name) 
        DO UPDATE SET 
            description = CASE WHEN $description IS NOT NULL THEN $description ELSE description END,
            role = CASE WHEN $role IS NOT NULL THEN $role ELSE role END,
            status = CASE WHEN $status IS NOT NULL THEN $status ELSE status END,
            last_updated = CURRENT_TIMESTAMP
    `).run({ campaignId, name, description: safeDesc, role: role || null, status: status || null });
    
    console.log(`[Dossier] 👤 Aggiornato NPC: ${name}`);
};

export const getNpcEntry = (campaignId: number, name: string): NpcEntry | undefined => {
    return db.prepare(`
        SELECT * FROM npc_dossier 
        WHERE campaign_id = ? AND lower(name) = lower(?)
    `).get(campaignId, name) as NpcEntry | undefined;
};

export const listNpcs = (campaignId: number, limit: number = 10): NpcEntry[] => {
    return db.prepare(`
        SELECT * FROM npc_dossier 
        WHERE campaign_id = ? 
        ORDER BY last_updated DESC 
        LIMIT ?
    `).all(campaignId, limit) as NpcEntry[];
};

export const findNpcDossierByName = (campaignId: number, nameQuery: string): NpcEntry[] => {
    // Cerca NPC il cui nome è contenuto nella query dell'utente
    // Es. Query: "Chi è Grog?" -> Trova record con name="Grog"
    // Usiamo LIKE con % per trovare occorrenze parziali
    return db.prepare(`
        SELECT * FROM npc_dossier 
        WHERE campaign_id = ? AND ? LIKE '%' || name || '%'
    `).all(campaignId, nameQuery) as NpcEntry[];
};

// --- FUNZIONI QUESTS ---

export const addQuest = (campaignId: number, title: string) => {
    // Evitiamo duplicati identici
    const exists = db.prepare("SELECT id FROM quests WHERE campaign_id = ? AND title = ?").get(campaignId, title);
    if (!exists) {
        db.prepare("INSERT INTO quests (campaign_id, title, status, created_at, last_updated) VALUES (?, ?, 'OPEN', ?, ?)").run(campaignId, title, Date.now(), Date.now());
        console.log(`[Quest] 🗺️ Nuova quest aggiunta: ${title}`);
    }
};

export const updateQuestStatus = (campaignId: number, titlePart: string, status: 'COMPLETED' | 'FAILED' | 'OPEN') => {
    db.prepare("UPDATE quests SET status = ?, last_updated = ? WHERE campaign_id = ? AND title LIKE ?").run(status, Date.now(), campaignId, `%${titlePart}%`);
    console.log(`[Quest] 📝 Stato aggiornato a ${status} per quest simile a: ${titlePart}`);
};

export const getOpenQuests = (campaignId: number): Quest[] => {
    return db.prepare("SELECT * FROM quests WHERE campaign_id = ? AND status = 'OPEN' ORDER BY created_at DESC").all(campaignId) as Quest[];
};

// --- FUNZIONI INVENTORY ---

export const addLoot = (campaignId: number, itemName: string, qty: number = 1) => {
    // Cerca se esiste già (case insensitive)
    const existing = db.prepare("SELECT id, quantity FROM inventory WHERE campaign_id = ? AND lower(item_name) = lower(?)").get(campaignId, itemName) as {id: number, quantity: number} | undefined;
    
    if (existing) {
        db.prepare("UPDATE inventory SET quantity = quantity + ?, last_updated = ? WHERE id = ?").run(qty, Date.now(), existing.id);
    } else {
        db.prepare("INSERT INTO inventory (campaign_id, item_name, quantity, acquired_at, last_updated) VALUES (?, ?, ?, ?, ?)").run(campaignId, itemName, qty, Date.now(), Date.now());
    }
    console.log(`[Loot] 💰 Aggiunto: ${itemName} (x${qty})`);
};

export const removeLoot = (campaignId: number, itemName: string, qty: number = 1) => {
    const existing = db.prepare("SELECT id, quantity FROM inventory WHERE campaign_id = ? AND lower(item_name) LIKE lower(?)").get(campaignId, `%${itemName}%`) as {id: number, quantity: number} | undefined;
    
    if (existing) {
        const newQty = existing.quantity - qty;
        if (newQty <= 0) {
            db.prepare("DELETE FROM inventory WHERE id = ?").run(existing.id);
        } else {
            db.prepare("UPDATE inventory SET quantity = ?, last_updated = ? WHERE id = ?").run(newQty, Date.now(), existing.id);
        }
        console.log(`[Loot] 📉 Rimosso: ${itemName} (x${qty})`);
        return true;
    }
    return false;
};

export const getInventory = (campaignId: number): InventoryItem[] => {
    return db.prepare("SELECT * FROM inventory WHERE campaign_id = ? ORDER BY item_name ASC").all(campaignId) as InventoryItem[];
};

// --- FUNZIONI STORIA PERSONAGGI ---

export const addCharacterEvent = (campaignId: number, charName: string, sessionId: string, description: string, type: string) => {
    db.prepare(`
        INSERT INTO character_history (campaign_id, character_name, session_id, event_type, description, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(campaignId, charName, sessionId, type, description, Date.now());
    console.log(`[Bio] 📜 Aggiunto evento per ${charName}: [${type}]`);
};

export const getCharacterHistory = (campaignId: number, charName: string): { description: string, event_type: string, session_id: string }[] => {
    // Recupera la storia in ordine cronologico (basato sull'ID inserimento che segue la cronologia sessioni)
    return db.prepare(`
        SELECT description, event_type, session_id 
        FROM character_history 
        WHERE campaign_id = ? AND lower(character_name) = lower(?)
        ORDER BY id ASC
    `).all(campaignId, charName) as any[];
};

// --- FUNZIONI STORIA NPC ---

export const addNpcEvent = (campaignId: number, npcName: string, sessionId: string, description: string, type: string) => {
    db.prepare(`
        INSERT INTO npc_history (campaign_id, npc_name, session_id, event_type, description, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(campaignId, npcName, sessionId, type, description, Date.now());
    console.log(`[Bio NPC] 📜 Aggiunto evento per ${npcName}: [${type}]`);
};

export const getNpcHistory = (campaignId: number, npcName: string): { description: string, event_type: string, session_id: string }[] => {
    return db.prepare(`
        SELECT description, event_type, session_id 
        FROM npc_history 
        WHERE campaign_id = ? AND lower(npc_name) = lower(?)
        ORDER BY id ASC
    `).all(campaignId, npcName) as any[];
};

// --- FUNZIONI STORIA DEL MONDO ---

export const addWorldEvent = (campaignId: number, sessionId: string | null, description: string, type: string, year?: number) => {
    // Se l'anno non è passato, prova a prendere quello corrente della campagna
    let eventYear = year;
    if (eventYear === undefined) {
        const camp = getCampaignById(campaignId);
        eventYear = camp?.current_year || 0;
    }

    db.prepare(`
        INSERT INTO world_history (campaign_id, session_id, event_type, description, timestamp, year)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(campaignId, sessionId, type, description, Date.now(), eventYear);
    console.log(`[World] 🌍 Aggiunto evento globale: [${type}] Anno: ${eventYear}`);
};

export const getWorldTimeline = (campaignId: number): { description: string, event_type: string, session_id: string, session_number?: number, year: number }[] => {
    // Join con la tabella sessions per avere il numero sessione se disponibile
    // ORDINAMENTO PER ANNO (year)
    return db.prepare(`
        SELECT w.description, w.event_type, w.session_id, w.year, s.session_number
        FROM world_history w
        LEFT JOIN sessions s ON w.session_id = s.session_id
        WHERE w.campaign_id = ?
        ORDER BY w.year ASC, w.id ASC
    `).all(campaignId) as any[];
};

// --- FUNZIONI SNAPSHOT (TOTAL RECALL) ---

export const getCampaignSnapshot = (campaignId: number): CampaignSnapshot => {
    // 1. Recupera i Personaggi
    const characters = getCampaignCharacters(campaignId);
    const pc_context = characters.map(c => `- ${c.character_name} (${c.class})`).join('\n');

    // 2. Recupera le Quest aperte
    const quests = db.prepare(`SELECT title FROM quests WHERE campaign_id = ? AND status = 'OPEN'`).all(campaignId) as any[];
    const quest_context = quests.map(q => q.title).join(', ');

    // 3. Recupera Luogo e descrizione Atlante
    const locRow = db.prepare(`SELECT current_macro_location as macro, current_micro_location as micro FROM campaigns WHERE id = ?`).get(campaignId) as any;
    
    let atlasDesc = null;
    let location_context = "Sconosciuto.";
    
    if (locRow) {
        const atlas = db.prepare(`SELECT description FROM location_atlas WHERE campaign_id = ? AND macro_location = ? AND micro_location = ?`)
            .get(campaignId, locRow.macro, locRow.micro) as any;
        atlasDesc = atlas?.description || null;
        location_context = `${locRow.macro || '?'} - ${locRow.micro || '?'}`;
    }

    return {
        characters,
        quests,
        location: locRow ? { macro: locRow.macro, micro: locRow.micro } : null,
        atlasDesc,
        pc_context,
        quest_context,
        location_context
    };
};

// ------------------------------------------

export const getCampaignById = (id: number): Campaign | undefined => {
    return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as Campaign | undefined;
};

export const deleteCampaign = (campaignId: number) => {
    // 1. Trova sessioni
    const sessions = db.prepare('SELECT session_id FROM sessions WHERE campaign_id = ?').all(campaignId) as { session_id: string }[];
    
    // 2. Elimina registrazioni e sessioni
    const deleteRec = db.prepare('DELETE FROM recordings WHERE session_id = ?');
    const deleteSess = db.prepare('DELETE FROM sessions WHERE session_id = ?');
    const deleteNotes = db.prepare('DELETE FROM session_notes WHERE session_id = ?');
    
    for (const s of sessions) {
        deleteRec.run(s.session_id);
        deleteNotes.run(s.session_id);
        deleteSess.run(s.session_id);
    }

    // --- NUOVO: PULIZIA MANUALE TABELLE ORFANE ---
    db.prepare('DELETE FROM location_atlas WHERE campaign_id = ?').run(campaignId);
    db.prepare('DELETE FROM location_history WHERE campaign_id = ?').run(campaignId);
    try { db.prepare('DELETE FROM npc_dossier WHERE campaign_id = ?').run(campaignId); } catch(e) {}
    try { db.prepare('DELETE FROM quests WHERE campaign_id = ?').run(campaignId); } catch(e) {}
    try { db.prepare('DELETE FROM inventory WHERE campaign_id = ?').run(campaignId); } catch(e) {}
    try { db.prepare('DELETE FROM character_history WHERE campaign_id = ?').run(campaignId); } catch(e) {}
    try { db.prepare('DELETE FROM npc_history WHERE campaign_id = ?').run(campaignId); } catch(e) {}
    try { db.prepare('DELETE FROM world_history WHERE campaign_id = ?').run(campaignId); } catch(e) {}

    // 3. Elimina campagna (Cascade farà il resto per characters e knowledge, ma meglio essere sicuri sopra)
    db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId);
    
    console.log(`[DB] Campagna ${campaignId} e tutti i dati correlati (Atlante, Storia, NPC, Quest, Loot) eliminati.`);
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

export const getCampaignCharacters = (campaignId: number): UserProfile[] & { user_id: string }[] => {
    return db.prepare('SELECT user_id, character_name, race, class, description FROM characters WHERE campaign_id = ?').all(campaignId) as UserProfile[] & { user_id: string }[];
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

export const deleteUserCharacter = (userId: string, campaignId: number) => {
    db.prepare('DELETE FROM characters WHERE user_id = ? AND campaign_id = ?').run(userId, campaignId);
};

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

export const saveRawTranscription = (filename: string, rawJson: string) => {
    db.prepare('UPDATE recordings SET raw_transcription_text = ? WHERE filename = ?').run(rawJson, filename);
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
        SELECT s.session_id, MIN(r.timestamp) as start_time, COUNT(r.id) as fragments, c.name as campaign_name, s.session_number, s.title
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

// --- FUNZIONI KNOWLEDGE BASE (RAG) ---

export const insertKnowledgeFragment = (campaignId: number, sessionId: string, content: string, embedding: number[], model: string, startTimestamp: number = 0, macro: string | null = null, micro: string | null = null, npcs: string[] = []) => {
    const npcString = npcs.join(',');
    db.prepare(`
        INSERT INTO knowledge_fragments (campaign_id, session_id, content, embedding_json, embedding_model, vector_dimension, start_timestamp, created_at, macro_location, micro_location, associated_npcs)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(campaignId, sessionId, content, JSON.stringify(embedding), model, embedding.length, startTimestamp, Date.now(), macro, micro, npcString);
};

export const getKnowledgeFragments = (campaignId: number, model: string): KnowledgeFragment[] => {
    return db.prepare(`
        SELECT * FROM knowledge_fragments
        WHERE campaign_id = ? AND embedding_model = ?
        ORDER BY start_timestamp ASC
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

    // 🆕 DROPPA LE TABELLE INVECE DI DELETE (per ricostruire lo schema completo)
    db.exec('DROP TABLE IF EXISTS recordings');
    db.exec('DROP TABLE IF EXISTS sessions');
    db.exec('DROP TABLE IF EXISTS session_notes');
    db.exec('DROP TABLE IF EXISTS knowledge_fragments');
    db.exec('DROP TABLE IF EXISTS location_history');
    db.exec('DROP TABLE IF EXISTS location_atlas');
    db.exec('DROP TABLE IF EXISTS npc_dossier');
    db.exec('DROP TABLE IF EXISTS quests');
    db.exec('DROP TABLE IF EXISTS inventory');
    db.exec('DROP TABLE IF EXISTS character_history');
    db.exec('DROP TABLE IF EXISTS npc_history');
    db.exec('DROP TABLE IF EXISTS world_history');
    db.exec('DROP TABLE IF EXISTS campaigns');
    db.exec('DROP TABLE IF EXISTS characters');
    db.exec('DROP TABLE IF EXISTS chat_history');

    // 🆕 RICREA LE TABELLE CON LO SCHEMA COMPLETO

    // --- TABELLA CAMPAGNE ---
    db.exec(`CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        is_active INTEGER DEFAULT 0,
        created_at INTEGER,
        current_location TEXT,
        current_macro_location TEXT,
        current_micro_location TEXT,
        current_year INTEGER
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

    // --- TABELLA SESSIONI ---
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        guild_id TEXT,
        campaign_id INTEGER,
        session_number INTEGER,
        title TEXT,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
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
        raw_transcription_text TEXT,
        error_log TEXT,
        macro_location TEXT,
        micro_location TEXT,
        present_npcs TEXT,
        character_name_snapshot TEXT,
        year INTEGER
    )`);

    // --- TABELLA NOTE SESSIONE ---
    db.exec(`CREATE TABLE IF NOT EXISTS session_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_id TEXT,
        content TEXT NOT NULL,
        timestamp INTEGER,
        created_at INTEGER,
        macro_location TEXT,
        micro_location TEXT
    )`);

    // --- TABELLA MEMORIA RAG ---
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
        macro_location TEXT,
        micro_location TEXT,
        associated_npcs TEXT,
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
        session_id TEXT,
        timestamp INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);

    // --- TABELLA ATLANTE ---
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
        role TEXT,
        description TEXT,
        status TEXT DEFAULT 'ALIVE',
        last_seen_location TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(campaign_id, name)
    )`);

    // --- TABELLA QUESTS ---
    db.exec(`CREATE TABLE IF NOT EXISTS quests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT DEFAULT 'OPEN',
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

    // --- TABELLA STORIA PERSONAGGI ---
    db.exec(`CREATE TABLE IF NOT EXISTS character_history (
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
    db.exec(`CREATE TABLE IF NOT EXISTS npc_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        npc_name TEXT NOT NULL,
        session_id TEXT,
        event_type TEXT,
        description TEXT NOT NULL,
        timestamp INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);

    // --- TABELLA STORIA MONDO ---
    db.exec(`CREATE TABLE IF NOT EXISTS world_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        session_id TEXT,
        event_type TEXT,
        description TEXT NOT NULL,
        timestamp INTEGER,
        year INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);

    // 🆕 RICREA GLI INDICI
    db.exec(`CREATE INDEX IF NOT EXISTS idx_recordings_session_id ON recordings (session_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings (status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_campaign ON sessions (campaign_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_campaign_model ON knowledge_fragments (campaign_id, embedding_model)`);

    db.exec('VACUUM');
    console.log("[DB] ✅ Database ricreato con schema completo.");
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

export { db };
