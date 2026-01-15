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
    created_at INTEGER,
    current_location TEXT,
    current_macro_location TEXT,
    current_micro_location TEXT,
    current_year INTEGER,
    allow_auto_character_update INTEGER DEFAULT 0
)`);

// --- TABELLA PERSONAGGI ---
db.exec(`CREATE TABLE IF NOT EXISTS characters (
    user_id TEXT NOT NULL,
    campaign_id INTEGER NOT NULL,
    character_name TEXT,
    race TEXT,
    class TEXT,
    description TEXT,
    rag_sync_needed INTEGER DEFAULT 0,
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
    year INTEGER,
    rag_sync_needed INTEGER DEFAULT 0,
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
    raw_transcription_text TEXT,
    error_log TEXT,
    macro_location TEXT,
    micro_location TEXT,
    present_npcs TEXT,
    character_name_snapshot TEXT,
    year INTEGER
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
    created_at INTEGER,
    macro_location TEXT,
    micro_location TEXT
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
    macro_location TEXT,
    micro_location TEXT,
    associated_npcs TEXT,
    associated_npc_ids TEXT,
    associated_entity_ids TEXT,
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

// --- TABELLA ATLANTE (MEMORIA LUOGHI) ---
db.exec(`CREATE TABLE IF NOT EXISTS location_atlas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    macro_location TEXT NOT NULL,
    micro_location TEXT NOT NULL,
    description TEXT,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    rag_sync_needed INTEGER DEFAULT 0,
    first_session_id TEXT, -- 🆕 Tracciamento origine
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
    rag_sync_needed INTEGER DEFAULT 0,
    aliases TEXT,
    first_session_id TEXT, -- 🆕 Tracciamento origine
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
    session_id TEXT,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
)`);

// --- TABELLA BESTIARIO (MOSTRI) ---
db.exec(`CREATE TABLE IF NOT EXISTS bestiary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'ALIVE', -- ALIVE, DEFEATED, FLED
    count TEXT, -- Es. "3", "molti", "un branco"
    session_id TEXT, -- Sessione in cui è stato incontrato
    last_seen INTEGER, -- Timestamp ultimo avvistamento
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_bestiary_campaign ON bestiary (campaign_id)`);
// 🆕 FIX: Indice univoco per upsert bestiario (per nuove installazioni)
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bestiary_unique ON bestiary(campaign_id, name, session_id) WHERE session_id IS NOT NULL`);

// --- TABELLA INVENTORY ---
db.exec(`CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    acquired_at INTEGER,
    last_updated INTEGER,
    session_id TEXT,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
)`);

// --- TABELLA PENDING MERGES ---
db.exec(`CREATE TABLE IF NOT EXISTS pending_merges (
    message_id TEXT PRIMARY KEY,
    campaign_id INTEGER,
    detected_name TEXT,
    target_name TEXT,
    new_description TEXT,
    role TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    "ALTER TABLE recordings ADD COLUMN raw_transcription_text TEXT",
    // 🆕 SISTEMA ARMONICO: Lazy sync RAG per NPC
    "ALTER TABLE npc_dossier ADD COLUMN rag_sync_needed INTEGER DEFAULT 0",
    // 🆕 SISTEMA ARMONICO: Lazy sync RAG per Atlas
    "ALTER TABLE location_atlas ADD COLUMN rag_sync_needed INTEGER DEFAULT 0",
    // 🆕 Tracciamento sessione per inventario e quest
    "ALTER TABLE inventory ADD COLUMN session_id TEXT",
    "ALTER TABLE quests ADD COLUMN session_id TEXT",
    // 🆕 SISTEMA ARMONICO: Lazy sync RAG per Timeline
    "ALTER TABLE world_history ADD COLUMN rag_sync_needed INTEGER DEFAULT 0",
    // 🆕 SISTEMA ARMONICO: Lazy sync RAG per Personaggi (PG)
    "ALTER TABLE characters ADD COLUMN rag_sync_needed INTEGER DEFAULT 0",
    // 🆕 SISTEMA ARMONICO: Flag per abilitare auto-update PG
    "ALTER TABLE campaigns ADD COLUMN allow_auto_character_update INTEGER DEFAULT 0",
    // 🆕 SISTEMA IBRIDO RAG: NPC ID invece di nomi per precisione
    "ALTER TABLE knowledge_fragments ADD COLUMN associated_npc_ids TEXT",
    // 🆕 SISTEMA IBRIDO RAG: Alias per NPC (soprannomi, titoli)
    "ALTER TABLE npc_dossier ADD COLUMN aliases TEXT",
    // 🆕 SISTEMA ENTITY REFS: Rinomina per supportare prefissi tipizzati (npc:1, pc:15, etc.)
    "ALTER TABLE knowledge_fragments ADD COLUMN associated_entity_ids TEXT",
    // 🆕 FIX: Indice univoco per upsert bestiario
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_bestiary_unique ON bestiary(campaign_id, name, session_id) WHERE session_id IS NOT NULL",
    // 🆕 TRACCIAMENTO ORIGINE PER RESET PULITO
    "ALTER TABLE npc_dossier ADD COLUMN first_session_id TEXT",
    "ALTER TABLE location_atlas ADD COLUMN first_session_id TEXT"
];

for (const m of migrations) {
    try { 
        db.exec(m); 
    } catch (e) { 
        // Ignora se la colonna esiste già, ma logga se è altro errore
        const err = e as { message: string };
        if (!err.message.includes('duplicate column name') && !err.message.includes('index idx_bestiary_unique already exists')) {
            console.error(`[DB] ⚠️ Migration error: "${m}"`, err);
        }
    }
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
    rag_sync_needed?: number; // NUOVO
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
    allow_auto_character_update?: number; // NUOVO
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
    associated_npc_ids?: string | null; // 🔄 Legacy - per retrocompatibilità
    associated_entity_ids?: string | null; // 🆕 Entity Refs (npc:1, pc:15, quest:42)
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
    aliases?: string | null; // 🆕 Sistema Ibrido RAG (soprannomi, titoli)
    first_session_id?: string | null; // 🆕 Tracciamento origine
}

export interface Quest {
    id: number;
    campaign_id: number;
    title: string;
    status: 'OPEN' | 'COMPLETED' | 'FAILED';
    created_at: number;
    last_updated: number;
    session_id?: string;
}

export interface InventoryItem {
    id: number;
    campaign_id: number;
    item_name: string;
    quantity: number;
    acquired_at: number;
    last_updated: number;
    session_id?: string;
}

export interface PendingMerge {
    message_id: string;
    campaign_id: number;
    detected_name: string;
    target_name: string;
    new_description: string;
    role: string;
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

export const setCampaignAutoUpdate = (campaignId: number, allow: boolean): void => {
    db.prepare('UPDATE campaigns SET allow_auto_character_update = ? WHERE id = ?').run(allow ? 1 : 0, campaignId);
    console.log(`[DB] ⚙️ Auto-update PG per campagna ${campaignId}: ${allow}`);
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

export const updateAtlasEntry = (campaignId: number, macro: string, micro: string, newDescription: string, sessionId?: string) => {
    // Sanitize: Force string if object is passed (AI hallucination fix)
    const safeDesc = (typeof newDescription === 'object') ? JSON.stringify(newDescription) : String(newDescription);

    // Upsert: Inserisci o Aggiorna se esiste
    // Se inseriamo (nuovo), salviamo first_session_id
    // Se aggiorniamo, manteniamo il first_session_id originale
    db.prepare(`
        INSERT INTO location_atlas (campaign_id, macro_location, micro_location, description, last_updated, first_session_id)
        VALUES ($campaignId, $macro, $micro, $desc, CURRENT_TIMESTAMP, $sessionId)
        ON CONFLICT(campaign_id, macro_location, micro_location) 
        DO UPDATE SET description = $desc, last_updated = CURRENT_TIMESTAMP
    `).run({ campaignId, macro, micro, desc: safeDesc, sessionId: sessionId || null });
    
    console.log(`[Atlas] 📖 Aggiornata voce per: ${macro} - ${micro}`);
};

/**
 * Lista tutte le voci dell'atlante per una campagna
 */
export const listAtlasEntries = (campaignId: number, limit: number = 15): any[] => {
    return db.prepare(`
        SELECT id, macro_location, micro_location, description, last_updated
        FROM location_atlas
        WHERE campaign_id = ?
        ORDER BY last_updated DESC
        LIMIT ?
    `).all(campaignId, limit);
};

/**
 * Lista TUTTE le voci dell'atlante per una campagna (per riconciliazione)
 */
export const listAllAtlasEntries = (campaignId: number): any[] => {
    return db.prepare(`
        SELECT id, macro_location, micro_location, description, last_updated
        FROM location_atlas
        WHERE campaign_id = ?
        ORDER BY last_updated DESC
    `).all(campaignId);
};

/**
 * Elimina una voce specifica dall'atlante
 */
export const deleteAtlasEntry = (campaignId: number, macro: string, micro: string): boolean => {
    const result = db.prepare(`
        DELETE FROM location_atlas
        WHERE campaign_id = ?
          AND lower(macro_location) = lower(?)
          AND lower(micro_location) = lower(?)
    `).run(campaignId, macro, micro);

    if (result.changes > 0) {
        console.log(`[Atlas] 🗑️ Eliminata voce: ${macro} - ${micro}`);
        return true;
    }
    return false;
};

/**
 * Ottiene una voce dell'atlante con tutti i campi
 */
export const getAtlasEntryFull = (campaignId: number, macro: string, micro: string): any | null => {
    return db.prepare(`
        SELECT id, macro_location, micro_location, description, last_updated
        FROM location_atlas
        WHERE campaign_id = ?
          AND lower(macro_location) = lower(?)
          AND lower(micro_location) = lower(?)
    `).get(campaignId, macro, micro) || null;
};

/**
 * Rinomina/Sposta una voce dell'atlante (cambia macro e/o micro location)
 * Opzionalmente aggiorna anche la cronologia dei viaggi
 */
export const renameAtlasEntry = (
    campaignId: number,
    oldMacro: string,
    oldMicro: string,
    newMacro: string,
    newMicro: string,
    updateHistory: boolean = false
): boolean => {
    const existing = getAtlasEntryFull(campaignId, oldMacro, oldMicro);
    if (!existing) return false;

    // Controlla se esiste già la destinazione
    const conflict = getAtlasEntryFull(campaignId, newMacro, newMicro);
    if (conflict) {
        console.error(`[Atlas] ⚠️ Destinazione ${newMacro} - ${newMicro} esiste già!`);
        return false;
    }

    db.transaction(() => {
        // Aggiorna la voce atlas
        db.prepare(`
            UPDATE location_atlas
            SET macro_location = ?, micro_location = ?, last_updated = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(newMacro, newMicro, existing.id);

        // Aggiorna la cronologia viaggi se richiesto
        if (updateHistory) {
            db.prepare(`
                UPDATE location_history
                SET macro_location = ?, micro_location = ?,
                    location = ? || ' | ' || ?
                WHERE campaign_id = ?
                  AND lower(macro_location) = lower(?)
                  AND lower(micro_location) = lower(?)
            `).run(newMacro, newMicro, newMacro, newMicro, campaignId, oldMacro, oldMicro);
        }
    })();

    console.log(`[Atlas] 🔄 Rinominato: ${oldMacro} - ${oldMicro} -> ${newMacro} - ${newMicro}`);
    return true;
};

/**
 * Unisce due voci dell'atlante (Smart Merge).
 * Aggiorna la descrizione del target, sposta la cronologia e elimina la source.
 */
export const mergeAtlasEntry = (
    campaignId: number,
    oldMacro: string,
    oldMicro: string,
    newMacro: string,
    newMicro: string,
    mergedDescription: string
): boolean => {
    const source = getAtlasEntryFull(campaignId, oldMacro, oldMicro);
    const target = getAtlasEntryFull(campaignId, newMacro, newMicro);

    if (!source || !target) return false;

    db.transaction(() => {
        // 1. Aggiorna descrizione target
        db.prepare(`
            UPDATE location_atlas
            SET description = ?, last_updated = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(mergedDescription, target.id);

        // 2. Sposta cronologia
        db.prepare(`
            UPDATE location_history
            SET macro_location = ?, micro_location = ?,
                location = ? || ' | ' || ?
            WHERE campaign_id = ?
              AND lower(macro_location) = lower(?)
              AND lower(micro_location) = lower(?)
        `).run(newMacro, newMicro, newMacro, newMicro, campaignId, oldMacro, oldMicro);

        // 3. Elimina source
        db.prepare(`DELETE FROM location_atlas WHERE id = ?`).run(source.id);
    })();

    console.log(`[Atlas] 🔀 Merged: ${oldMacro} - ${oldMicro} -> ${newMacro} - ${newMicro}`);
    return true;
};

/**
 * Ottiene la cronologia viaggi con ID per poterla modificare
 */
export const getLocationHistoryWithIds = (campaignId: number, limit: number = 20): any[] => {
    return db.prepare(`
        SELECT id, macro_location, micro_location, timestamp, session_date, session_id
        FROM location_history
        WHERE campaign_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
    `).all(campaignId, limit);
};

/**
 * Corregge una singola voce nella cronologia viaggi
 */
export const fixLocationHistoryEntry = (
    entryId: number,
    newMacro: string,
    newMicro: string
): boolean => {
    const result = db.prepare(`
        UPDATE location_history
        SET macro_location = ?,
            micro_location = ?,
            location = ? || ' | ' || ?
        WHERE id = ?
    `).run(newMacro, newMicro, newMacro, newMicro, entryId);

    if (result.changes > 0) {
        console.log(`[History] 🔧 Corretta voce #${entryId}: ${newMacro} - ${newMicro}`);
        return true;
    }
    return false;
};

/**
 * Elimina una voce dalla cronologia viaggi
 */
export const deleteLocationHistoryEntry = (id: number): boolean => {
    const result = db.prepare('DELETE FROM location_history WHERE id = ?').run(id);
    if (result.changes > 0) {
        console.log(`[History] 🗑️ Eliminata voce viaggio #${id}`);
        return true;
    }
    return false;
};

/**
 * Aggiorna anche la posizione corrente della campagna
 */
export const fixCurrentLocation = (campaignId: number, newMacro: string, newMicro: string): void => {
    db.prepare(`
        UPDATE campaigns
        SET current_macro_location = ?, current_micro_location = ?
        WHERE id = ?
    `).run(newMacro, newMicro, campaignId);
    console.log(`[Campaign] 📍 Posizione corrente aggiornata: ${newMacro} - ${newMicro}`);
};

// --- FUNZIONI DOSSIER NPC ---

export const updateNpcEntry = (campaignId: number, name: string, description: string, role?: string, status?: string, sessionId?: string) => {
    // Sanitize: Force string if object is passed
    const safeDesc = (typeof description === 'object') ? JSON.stringify(description) : String(description);

    // Upsert intelligente
    // Se inseriamo (nuovo), salviamo first_session_id
    // Se aggiorniamo, manteniamo il first_session_id originale
    db.prepare(`
        INSERT INTO npc_dossier (campaign_id, name, description, role, status, last_updated, first_session_id)
        VALUES ($campaignId, $name, $description, $role, $status, CURRENT_TIMESTAMP, $sessionId)
        ON CONFLICT(campaign_id, name) 
        DO UPDATE SET 
            description = CASE WHEN $description IS NOT NULL THEN $description ELSE description END,
            role = CASE WHEN $role IS NOT NULL THEN $role ELSE role END,
            status = CASE WHEN $status IS NOT NULL THEN $status ELSE status END,
            last_updated = CURRENT_TIMESTAMP
    `).run({ campaignId, name, description: safeDesc, role: role || null, status: status || null, sessionId: sessionId || null });
    
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

// --- FUNZIONI BESTIARIO (MOSTRI) ---

export interface BestiaryEntry {
    id: number;
    campaign_id: number;
    name: string;
    status: string;
    count: string | null;
    session_id: string | null;
    last_seen: number | null;
}

/**
 * Aggiunge o aggiorna un mostro nel bestiario
 */
export const upsertMonster = (
    campaignId: number,
    name: string,
    status: string,
    count?: string,
    sessionId?: string
): void => {
    db.prepare(`
        INSERT INTO bestiary (campaign_id, name, status, count, session_id, last_seen)
        VALUES ($campaignId, $name, $status, $count, $sessionId, $now)
        ON CONFLICT(campaign_id, name, session_id) WHERE session_id IS NOT NULL
        DO UPDATE SET
            status = $status,
            count = COALESCE($count, count),
            last_seen = $now
    `).run({
        campaignId,
        name,
        status: status || 'ALIVE',
        count: count || null,
        sessionId: sessionId || null,
        now: Date.now()
    });
    console.log(`[Bestiario] 👹 ${name} (${status})`);
};

/**
 * Lista tutti i mostri incontrati in una campagna
 */
export const listMonsters = (campaignId: number, limit: number = 20): BestiaryEntry[] => {
    return db.prepare(`
        SELECT * FROM bestiary
        WHERE campaign_id = ?
        ORDER BY last_seen DESC
        LIMIT ?
    `).all(campaignId, limit) as BestiaryEntry[];
};

/**
 * Lista mostri incontrati in una sessione specifica
 */
export const getSessionMonsters = (sessionId: string): BestiaryEntry[] => {
    return db.prepare(`
        SELECT * FROM bestiary
        WHERE session_id = ?
        ORDER BY last_seen DESC
    `).all(sessionId) as BestiaryEntry[];
};

// --- SISTEMA ENTITY REFS (Typed Prefixes for RAG) ---

/**
 * Entity Reference Types - Prefissi tipizzati per disambiguare entità nel RAG
 * Formato: "type:id" es. "npc:1", "pc:15", "quest:42", "loc:7"
 */
export type EntityType = 'npc' | 'pc' | 'quest' | 'loc';

export interface EntityRef {
    type: EntityType;
    id: number;
}

/**
 * Crea un entity ref (es. "npc:1")
 */
export const createEntityRef = (type: EntityType, id: number): string => `${type}:${id}`;

/**
 * Parsa un entity ref (es. "npc:1" -> { type: 'npc', id: 1 })
 */
export const parseEntityRef = (ref: string): EntityRef | null => {
    const match = ref.match(/^(npc|pc|quest|loc):(\d+)$/);
    if (!match) return null;
    return { type: match[1] as EntityType, id: parseInt(match[2]) };
};

/**
 * Parsa una stringa di entity refs (es. "npc:1,npc:2,pc:5")
 */
export const parseEntityRefs = (refs: string | null): EntityRef[] => {
    if (!refs) return [];
    return refs.split(',')
        .map(r => parseEntityRef(r.trim()))
        .filter((r): r is EntityRef => r !== null);
};

/**
 * Crea una stringa di entity refs da un array
 */
export const serializeEntityRefs = (refs: EntityRef[]): string => {
    return refs.map(r => createEntityRef(r.type, r.id)).join(',');
};

/**
 * Filtra entity refs per tipo
 */
export const filterEntityRefsByType = (refs: EntityRef[], type: EntityType): number[] => {
    return refs.filter(r => r.type === type).map(r => r.id);
};

/**
 * Migra vecchi ID numerici (backward compatibility)
 * Converte "1,2,3" -> "npc:1,npc:2,npc:3"
 */
export const migrateOldNpcIds = (oldIds: string | null): string | null => {
    if (!oldIds) return null;

    // Se già nel nuovo formato, ritorna come è
    if (oldIds.includes(':')) return oldIds;

    // Converti vecchi ID numerici in npc:ID
    const ids = oldIds.split(',').map(id => id.trim()).filter(id => id && !isNaN(parseInt(id)));
    if (ids.length === 0) return null;

    return ids.map(id => `npc:${id}`).join(',');
};

// --- FUNZIONI SISTEMA IBRIDO RAG (ID + ALIAS) ---

/**
 * Trova NPC per nome o alias (case insensitive).
 * Usato per risolvere nomi in ID per il sistema RAG.
 */
export const getNpcByNameOrAlias = (campaignId: number, nameOrAlias: string): NpcEntry | undefined => {
    // Prima cerca per nome esatto
    const byName = db.prepare(`
        SELECT * FROM npc_dossier
        WHERE campaign_id = ? AND LOWER(name) = LOWER(?)
    `).get(campaignId, nameOrAlias) as NpcEntry | undefined;

    if (byName) return byName;

    // Poi cerca negli alias
    return db.prepare(`
        SELECT * FROM npc_dossier
        WHERE campaign_id = ? AND LOWER(aliases) LIKE '%' || LOWER(?) || '%'
    `).get(campaignId, nameOrAlias) as NpcEntry | undefined;
};

/**
 * Ottieni ID NPC dal nome (cerca anche negli alias).
 */
export const getNpcIdByName = (campaignId: number, name: string): number | null => {
    const npc = getNpcByNameOrAlias(campaignId, name);
    return npc?.id || null;
};

/**
 * Ottieni nome NPC dall'ID.
 */
export const getNpcNameById = (campaignId: number, npcId: number): string | null => {
    const npc = db.prepare(`
        SELECT name FROM npc_dossier
        WHERE campaign_id = ? AND id = ?
    `).get(campaignId, npcId) as { name: string } | undefined;
    return npc?.name || null;
};

/**
 * Aggiorna gli alias di un NPC.
 */
export const updateNpcAliases = (campaignId: number, name: string, aliases: string[]): boolean => {
    const result = db.prepare(`
        UPDATE npc_dossier
        SET aliases = ?, last_updated = CURRENT_TIMESTAMP
        WHERE campaign_id = ? AND LOWER(name) = LOWER(?)
    `).run(aliases.join(','), campaignId, name);
    return result.changes > 0;
};

/**
 * Aggiungi un alias a un NPC (senza rimuovere quelli esistenti).
 */
export const addNpcAlias = (campaignId: number, name: string, newAlias: string): boolean => {
    const npc = getNpcEntry(campaignId, name);
    if (!npc) return false;

    const currentAliases = npc.aliases?.split(',').map(a => a.trim()).filter(a => a) || [];
    if (currentAliases.some(a => a.toLowerCase() === newAlias.toLowerCase())) {
        return false; // Alias già presente
    }

    currentAliases.push(newAlias);
    return updateNpcAliases(campaignId, name, currentAliases);
};

/**
 * Rimuovi un alias da un NPC.
 */
export const removeNpcAlias = (campaignId: number, name: string, aliasToRemove: string): boolean => {
    const npc = getNpcEntry(campaignId, name);
    if (!npc) return false;

    const currentAliases = npc.aliases?.split(',').map(a => a.trim()).filter(a => a) || [];
    const filtered = currentAliases.filter(a => a.toLowerCase() !== aliasToRemove.toLowerCase());

    if (filtered.length === currentAliases.length) return false; // Alias non trovato

    return updateNpcAliases(campaignId, name, filtered);
};

/**
 * Migra i riferimenti RAG da nome a ID dopo un merge/rename.
 */
export const migrateRagNpcReferences = (campaignId: number, oldNpcId: number, newNpcId: number): number => {
    // Cerca sia nel nuovo formato (npc:ID) che nel vecchio (ID numerico)
    const oldRef = createEntityRef('npc', oldNpcId);
    const newRef = createEntityRef('npc', newNpcId);

    const fragments = db.prepare(`
        SELECT id, associated_npc_ids, associated_entity_ids FROM knowledge_fragments
        WHERE campaign_id = ? AND (
            associated_entity_ids LIKE '%${oldRef}%' OR
            associated_npc_ids LIKE '%${oldNpcId}%'
        )
    `).all(campaignId) as { id: number; associated_npc_ids: string | null; associated_entity_ids: string | null }[];

    let migrated = 0;
    const updateStmt = db.prepare(`UPDATE knowledge_fragments SET associated_npc_ids = ?, associated_entity_ids = ? WHERE id = ?`);

    for (const f of fragments) {
        let updatedEntityIds = f.associated_entity_ids;
        let updatedNpcIds = f.associated_npc_ids;

        // Aggiorna entity refs (nuovo formato)
        if (f.associated_entity_ids) {
            updatedEntityIds = f.associated_entity_ids
                .split(',')
                .map(ref => ref.trim() === oldRef ? newRef : ref.trim())
                .filter((v, i, a) => a.indexOf(v) === i) // Rimuovi duplicati
                .join(',');
        }

        // Aggiorna legacy npc_ids (retrocompatibilità)
        if (f.associated_npc_ids) {
            const ids = f.associated_npc_ids.split(',').map(id => parseInt(id.trim()));
            const updatedIds = ids.map(id => id === oldNpcId ? newNpcId : id);
            const uniqueIds = [...new Set(updatedIds)];
            updatedNpcIds = uniqueIds.join(',');
        }

        updateStmt.run(updatedNpcIds, updatedEntityIds, f.id);
        migrated++;
    }

    console.log(`[RAG] 🔄 Migrati ${migrated} frammenti da NPC #${oldNpcId} (${oldRef}) a #${newNpcId} (${newRef})`);
    return migrated;
};

/**
 * Rimuove i vecchi frammenti "DOSSIER_UPDATE" per un NPC specifico.
 * Usato per pulire il RAG prima di inserire una biografia aggiornata.
 */
export const deleteNpcRagSummary = (campaignId: number, npcName: string): void => {
    db.prepare(`
        DELETE FROM knowledge_fragments
        WHERE campaign_id = ?
          AND session_id = 'DOSSIER_UPDATE'
          AND associated_npcs LIKE ?
    `).run(campaignId, `%${npcName}%`);

    console.log(`[RAG] 🧹 Puliti vecchi riassunti per: ${npcName}`);
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

// --- FUNZIONI MANUTENZIONE NPC ---

/**
 * Rinomina un NPC. Se il nuovo nome esiste già, unisce le descrizioni.
 */
export const renameNpcEntry = (campaignId: number, oldName: string, newName: string): boolean => {
    const existing = getNpcEntry(campaignId, oldName);
    if (!existing) return false;
    
    const conflict = getNpcEntry(campaignId, newName);
    
    db.transaction(() => {
        if (conflict) {
            // MERGE: Unisce le descrizioni e aggiorna la cronologia
            const mergedDesc = [existing.description, conflict.description]
                .filter(d => d && d.trim().length > 0).join(' | ');
            
            // Aggiorna il record di destinazione
            db.prepare(`
                UPDATE npc_dossier 
                SET description = ?, last_updated = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(mergedDesc, conflict.id);
            
            // Aggiorna la cronologia per puntare al nuovo nome
            db.prepare(`
                UPDATE npc_history 
                SET npc_name = ? 
                WHERE campaign_id = ? AND lower(npc_name) = lower(?)
            `).run(newName, campaignId, oldName);

            // Elimina il vecchio record
            db.prepare(`DELETE FROM npc_dossier WHERE id = ?`).run(existing.id);
            console.log(`[DB] NPC Merged: "${oldName}" -> "${newName}"`);
        } else {
            // RENAME SEMPLICE
            db.prepare(`UPDATE npc_dossier SET name = ? WHERE id = ?`).run(newName, existing.id);
            
            // Aggiorna anche la cronologia
            db.prepare(`
                UPDATE npc_history 
                SET npc_name = ? 
                WHERE campaign_id = ? AND lower(npc_name) = lower(?)
            `).run(newName, campaignId, oldName);
            
            console.log(`[DB] NPC Renamed: "${oldName}" -> "${newName}"`);
        }
    })();
    
    return true;
};

/**
 * Elimina un NPC dal dossier e dalla sua cronologia.
 */
export const deleteNpcEntry = (campaignId: number, name: string): boolean => {
    const existing = getNpcEntry(campaignId, name);
    if (!existing) return false;
    
    db.transaction(() => {
        // Elimina dal dossier
        db.prepare(`DELETE FROM npc_dossier WHERE id = ?`).run(existing.id);
        
        // Elimina dalla cronologia (opzionale, ma pulito)
        db.prepare(`DELETE FROM npc_history WHERE campaign_id = ? AND lower(npc_name) = lower(?)`).run(campaignId, name);
    })();
    
    console.log(`[DB] NPC Deleted: "${name}"`);
    return true;
};

/**
 * Aggiorna campi specifici di un NPC esistente
 */
export const updateNpcFields = (
    campaignId: number,
    currentName: string,
    updates: {
        name?: string;        // Nuovo nome
        description?: string; // Nuova descrizione
        role?: string;        // Nuovo ruolo
        status?: string;      // ALIVE, DEAD, MISSING
    }
): boolean => {
    const existing = getNpcEntry(campaignId, currentName);
    if (!existing) {
        console.error(`[DB] NPC "${currentName}" non trovato.`);
        return false;
    }

    // Costruisci query dinamica per aggiornare solo i campi forniti
    const setClauses: string[] = [];
    const params: any[] = [];

    if (updates.name !== undefined && updates.name !== currentName) {
        setClauses.push('name = ?');
        params.push(updates.name);
    }

    if (updates.description !== undefined) {
        setClauses.push('description = ?');
        params.push(updates.description);
    }

    if (updates.role !== undefined) {
        setClauses.push('role = ?');
        params.push(updates.role);
    }

    if (updates.status !== undefined) {
        setClauses.push('status = ?');
        params.push(updates.status.toUpperCase());
    }

    if (setClauses.length === 0) return false;

    setClauses.push('last_updated = CURRENT_TIMESTAMP');
    params.push(existing.id);

    const query = `UPDATE npc_dossier SET ${setClauses.join(', ')} WHERE id = ?`;
    
    try {
        db.prepare(query).run(...params);
        
        // Se il nome è cambiato, aggiorna anche la history
        if (updates.name && updates.name !== currentName) {
             db.prepare(`
                UPDATE npc_history 
                SET npc_name = ? 
                WHERE campaign_id = ? AND lower(npc_name) = lower(?)
            `).run(updates.name, campaignId, currentName);
        }

        console.log(`[DB] NPC "${currentName}" aggiornato:`, updates);
        return true;
    } catch (err) {
        console.error('[DB] Errore aggiornamento NPC:', err);
        return false;
    }
};

export const migrateKnowledgeFragments = (campaignId: number, oldName: string, newName: string) => {
    const fragments = db.prepare(`SELECT id, associated_npcs FROM knowledge_fragments WHERE campaign_id = ? AND associated_npcs LIKE ?`).all(campaignId, `%${oldName}%`) as {id: number, associated_npcs: string}[];

    const updateStmt = db.prepare(`UPDATE knowledge_fragments SET associated_npcs = ? WHERE id = ?`);

    for (const f of fragments) {
        if (!f.associated_npcs) continue;
        const npcs = f.associated_npcs.split(',').map(n => n.trim());
        const index = npcs.findIndex(n => n.toLowerCase() === oldName.toLowerCase());
        if (index !== -1) {
            npcs[index] = newName;
            updateStmt.run(npcs.join(','), f.id);
        }
    }
    console.log(`[DB] 🧠 Migrati riferimenti RAG da "${oldName}" a "${newName}"`);
};

/**
 * Marca un NPC come "dirty" per sync RAG lazy
 */
export const markNpcDirty = (campaignId: number, npcName: string): void => {
    db.prepare(`
        UPDATE npc_dossier
        SET rag_sync_needed = 1
        WHERE campaign_id = ? AND lower(name) = lower(?)
    `).run(campaignId, npcName);
};

/**
 * Recupera tutti gli NPC che necessitano sync RAG
 */
export const getDirtyNpcs = (campaignId: number): NpcEntry[] => {
    return db.prepare(`
        SELECT *
        FROM npc_dossier
        WHERE campaign_id = ? AND rag_sync_needed = 1
    `).all(campaignId) as NpcEntry[];
};

/**
 * Resetta il flag dirty dopo sync
 */
export const clearNpcDirtyFlag = (campaignId: number, npcName: string): void => {
    db.prepare(`
        UPDATE npc_dossier
        SET rag_sync_needed = 0
        WHERE campaign_id = ? AND lower(name) = lower(?)
    `).run(campaignId, npcName);
};

// --- FUNZIONI ATLAS DIRTY (LAZY RAG SYNC) ---

/**
 * Rimuove i vecchi frammenti "ATLAS_UPDATE" per un luogo specifico.
 * Usato per pulire il RAG prima di inserire una descrizione aggiornata.
 */
export const deleteAtlasRagSummary = (campaignId: number, macro: string, micro: string): void => {
    // Usiamo una combinazione di macro e micro per identificare il luogo
    const locationKey = `${macro}|${micro}`;
    db.prepare(`
        DELETE FROM knowledge_fragments
        WHERE campaign_id = ?
          AND session_id = 'ATLAS_UPDATE'
          AND content LIKE ?
    `).run(campaignId, `%${locationKey}%`);

    console.log(`[RAG] 🧹 Puliti vecchi riassunti atlas per: ${macro} - ${micro}`);
};

/**
 * Marca un luogo come "dirty" per sync RAG lazy
 */
export const markAtlasDirty = (campaignId: number, macro: string, micro: string): void => {
    db.prepare(`
        UPDATE location_atlas
        SET rag_sync_needed = 1
        WHERE campaign_id = ? AND lower(macro_location) = lower(?) AND lower(micro_location) = lower(?)
    `).run(campaignId, macro, micro);
    console.log(`[Atlas] 🔄 Marcato per sync RAG: ${macro} - ${micro}`);
};

/**
 * Recupera tutti i luoghi che necessitano sync RAG
 */
export interface AtlasEntryFull {
    id: number;
    campaign_id: number;
    macro_location: string;
    micro_location: string;
    description: string | null;
    last_updated: string;
    rag_sync_needed?: number;
}

export const getDirtyAtlasEntries = (campaignId: number): AtlasEntryFull[] => {
    return db.prepare(`
        SELECT *
        FROM location_atlas
        WHERE campaign_id = ? AND rag_sync_needed = 1
    `).all(campaignId) as AtlasEntryFull[];
};

/**
 * Resetta il flag dirty dopo sync
 */
export const clearAtlasDirtyFlag = (campaignId: number, macro: string, micro: string): void => {
    db.prepare(`
        UPDATE location_atlas
        SET rag_sync_needed = 0
        WHERE campaign_id = ? AND lower(macro_location) = lower(?) AND lower(micro_location) = lower(?)
    `).run(campaignId, macro, micro);
};

// --- FUNZIONI PENDING MERGES ---

export const addPendingMerge = (data: PendingMerge) => {
    const stmt = db.prepare(`
        INSERT INTO pending_merges (message_id, campaign_id, detected_name, target_name, new_description, role)
        VALUES (@message_id, @campaign_id, @detected_name, @target_name, @new_description, @role)
    `);
    stmt.run(data);
};

export const removePendingMerge = (messageId: string) => {
    db.prepare('DELETE FROM pending_merges WHERE message_id = ?').run(messageId);
};

export const getAllPendingMerges = (): PendingMerge[] => {
    return db.prepare('SELECT * FROM pending_merges').all() as PendingMerge[];
};

// --- FUNZIONI QUESTS ---

// Helper per calcolare la distanza di Levenshtein (Fuzzy Match)
function levenshteinDistance(a: string, b: string): number {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

function calculateSimilarity(a: string, b: string): number {
    const distance = levenshteinDistance(a, b);
    const maxLength = Math.max(a.length, b.length);
    return maxLength === 0 ? 1.0 : 1.0 - (distance / maxLength);
}

// Helper per pulire il titolo della quest dai suffissi di stato
function cleanQuestTitle(title: string): string {
    // Rimuove suffissi come (Completata), (In corso), - Attiva, ecc.
    // Rimuove anche spazi extra e converte in lowercase per il confronto
    return title
        .replace(/[-\s\(]*(completata|in corso|attiva|fallita|parzialmente|sospesa)[^)]*\)?\s*$/i, '')
        .trim()
        .toLowerCase();
}

export const addQuest = (campaignId: number, title: string, sessionId?: string) => {
    // 1. Normalizza il titolo in ingresso
    const cleanTitle = cleanQuestTitle(title);
    
    // 2. Recupera tutte le quest attive (o anche completate recenti se necessario, ma per ora attive)
    const existingQuests = db.prepare("SELECT title FROM quests WHERE campaign_id = ?").all(campaignId) as { title: string }[];

    // 3. Controllo Fuzzy Match
    for (const q of existingQuests) {
        const cleanExisting = cleanQuestTitle(q.title);
        
        // Se sono molto simili (> 85%), consideralo un duplicato
        if (calculateSimilarity(cleanTitle, cleanExisting) > 0.85) {
            console.log(`[Quest] 🛡️ Duplicato evitato: "${title}" è simile a "${q.title}"`);
            return; // Esci senza inserire
        }
    }

    // 4. Inserimento se nessun duplicato trovato
    db.prepare("INSERT INTO quests (campaign_id, title, status, created_at, last_updated, session_id) VALUES (?, ?, 'OPEN', ?, ?, ?)").run(campaignId, title, Date.now(), Date.now(), sessionId || null);
    console.log(`[Quest] 🗺️ Nuova quest aggiunta: ${title}`);
};

/**
 * Recupera le quest di una sessione specifica
 */
export const getSessionQuests = (sessionId: string): any[] => {
    return db.prepare(`
        SELECT id, title, status, created_at, last_updated
        FROM quests
        WHERE session_id = ?
        ORDER BY created_at DESC
    `).all(sessionId);
};

export const updateQuestStatus = (campaignId: number, titlePart: string, status: 'COMPLETED' | 'FAILED' | 'OPEN') => {
    db.prepare("UPDATE quests SET status = ?, last_updated = ? WHERE campaign_id = ? AND title LIKE ?").run(status, Date.now(), campaignId, `%${titlePart}%`);
    console.log(`[Quest] 📝 Stato aggiornato a ${status} per quest simile a: ${titlePart}`);
};

// 🆕 NUOVO: Aggiorna stato quest per ID
export const updateQuestStatusById = (questId: number, status: 'COMPLETED' | 'FAILED' | 'OPEN'): boolean => {
    const result = db.prepare("UPDATE quests SET status = ?, last_updated = ? WHERE id = ?").run(status, Date.now(), questId);
    if (result.changes > 0) {
        console.log(`[Quest] 📝 Stato aggiornato a ${status} per quest #${questId}`);
        return true;
    }
    return false;
};

// 🆕 NUOVO: Elimina quest per ID
export const deleteQuest = (questId: number): boolean => {
    const result = db.prepare("DELETE FROM quests WHERE id = ?").run(questId);
    if (result.changes > 0) {
        console.log(`[Quest] 🗑️ Quest #${questId} eliminata.`);
        return true;
    }
    return false;
};

export const getOpenQuests = (campaignId: number): Quest[] => {
    return db.prepare("SELECT * FROM quests WHERE campaign_id = ? AND status = 'OPEN' ORDER BY created_at DESC").all(campaignId) as Quest[];
};

// --- FUNZIONI INVENTORY ---

export const addLoot = (campaignId: number, itemName: string, qty: number = 1, sessionId?: string) => {
    // Cerca se esiste già (case insensitive)
    const existing = db.prepare("SELECT id, quantity FROM inventory WHERE campaign_id = ? AND lower(item_name) = lower(?)").get(campaignId, itemName) as {id: number, quantity: number} | undefined;

    if (existing) {
        db.prepare("UPDATE inventory SET quantity = quantity + ?, last_updated = ?, session_id = COALESCE(session_id, ?) WHERE id = ?").run(qty, Date.now(), sessionId || null, existing.id);
    } else {
        db.prepare("INSERT INTO inventory (campaign_id, item_name, quantity, acquired_at, last_updated, session_id) VALUES (?, ?, ?, ?, ?, ?)").run(campaignId, itemName, qty, Date.now(), Date.now(), sessionId || null);
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

/**
 * Recupera gli oggetti acquisiti in una sessione specifica
 */
export const getSessionInventory = (sessionId: string): any[] => {
    return db.prepare(`
        SELECT id, item_name, quantity, acquired_at
        FROM inventory
        WHERE session_id = ?
        ORDER BY acquired_at DESC
    `).all(sessionId);
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

    // 🆕 Imposta rag_sync_needed = 1 (Dirty)
    db.prepare(`
        INSERT INTO world_history (campaign_id, session_id, event_type, description, timestamp, year, rag_sync_needed)
        VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(campaignId, sessionId, type, description, Date.now(), eventYear);
    console.log(`[World] 🌍 Aggiunto evento globale (Dirty): [${type}] Anno: ${eventYear}`);
};

export const getWorldTimeline = (campaignId: number): { id: number, description: string, event_type: string, session_id: string | null, session_number?: number, year: number }[] => {
    // Join con la tabella sessions per avere il numero sessione se disponibile
    // ORDINAMENTO PER ANNO (year)
    return db.prepare(`
        SELECT w.id, w.description, w.event_type, w.session_id, w.year, s.session_number
        FROM world_history w
        LEFT JOIN sessions s ON w.session_id = s.session_id
        WHERE w.campaign_id = ?
        ORDER BY w.year ASC, w.id ASC
    `).all(campaignId) as any[];
};

export const deleteWorldEvent = (eventId: number): boolean => {
    // 1. Recupera l'evento per avere il testo da cancellare dal RAG
    const event = db.prepare('SELECT description, event_type FROM world_history WHERE id = ?').get(eventId) as { description: string, event_type: string } | undefined;

    if (!event) return false;

    // 2. Cancella dal DB SQL
    const result = db.prepare('DELETE FROM world_history WHERE id = ?').run(eventId);
    
    if (result.changes > 0) {
        // 3. Cancella dal RAG (knowledge_fragments)
        // Il formato usato in ingestWorldEvent è: `STORIA DEL MONDO: TIPO ${type}. EVENTO: ${event}`
        // Cerchiamo frammenti che contengono la descrizione esatta
        const ragContentPattern = `%EVENTO: ${event.description}%`;
        
        const ragResult = db.prepare(`
            DELETE FROM knowledge_fragments 
            WHERE content LIKE ?
        `).run(ragContentPattern);

        console.log(`[Timeline] 🗑️ Cancellato evento #${eventId} (SQL) e ${ragResult.changes} frammenti RAG.`);
        return true;
    }

    return false;
};

// --- FUNZIONI TIMELINE DIRTY (LAZY RAG SYNC) ---

export interface WorldEventFull {
    id: number;
    campaign_id: number;
    session_id: string | null;
    event_type: string;
    description: string;
    year: number;
    rag_sync_needed?: number;
}

/**
 * Recupera tutti gli eventi timeline che necessitano sync RAG
 */
export const getDirtyWorldEvents = (campaignId: number): WorldEventFull[] => {
    return db.prepare(`
        SELECT *
        FROM world_history
        WHERE campaign_id = ? AND rag_sync_needed = 1
    `).all(campaignId) as WorldEventFull[];
};

/**
 * Resetta il flag dirty dopo sync
 */
export const clearWorldEventDirtyFlag = (eventId: number): void => {
    db.prepare(`
        UPDATE world_history
        SET rag_sync_needed = 0
        WHERE id = ?
    `).run(eventId);
};

// --- FUNZIONI CHARACTER DIRTY (LAZY RAG SYNC) ---

export const markCharacterDirty = (campaignId: number, userId: string): void => {
    db.prepare(`
        UPDATE characters SET rag_sync_needed = 1 
        WHERE campaign_id = ? AND user_id = ?
    `).run(campaignId, userId);
};

export const clearCharacterDirtyFlag = (campaignId: number, userId: string): void => {
    db.prepare(`
        UPDATE characters SET rag_sync_needed = 0 
        WHERE campaign_id = ? AND user_id = ?
    `).run(campaignId, userId);
};

export const getDirtyCharacters = (campaignId: number): { user_id: string, character_name: string }[] => {
    return db.prepare(`
        SELECT user_id, character_name FROM characters
        WHERE campaign_id = ? AND rag_sync_needed = 1
    `).all(campaignId) as { user_id: string, character_name: string }[];
};

// Marca dirty per nome personaggio (utile per event processing)
export const markCharacterDirtyByName = (campaignId: number, characterName: string): void => {
    db.prepare(`
        UPDATE characters SET rag_sync_needed = 1
        WHERE campaign_id = ? AND LOWER(character_name) = LOWER(?)
    `).run(campaignId, characterName);
};

// Ottieni user_id dal nome personaggio
export const getCharacterUserId = (campaignId: number, characterName: string): string | null => {
    const row = db.prepare(`
        SELECT user_id FROM characters
        WHERE campaign_id = ? AND LOWER(character_name) = LOWER(?)
    `).get(campaignId, characterName) as { user_id: string } | undefined;
    return row?.user_id || null;
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
    const row = db.prepare('SELECT character_name, race, class, description, rag_sync_needed FROM characters WHERE user_id = ? AND campaign_id = ?').get(userId, campaignId) as UserProfile | undefined;
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

/**
 * Aggiorna present_npcs per tutte le registrazioni PROCESSED di una sessione.
 * Usato dopo generateSummary() per popolare gli NPC incontrati a livello di sessione.
 */
export const updateSessionPresentNPCs = (sessionId: string, npcs: string[]) => {
    if (!npcs || npcs.length === 0) return;
    const npcString = npcs.join(',');
    db.prepare(`
        UPDATE recordings
        SET present_npcs = ?
        WHERE session_id = ? AND status = 'PROCESSED'
    `).run(npcString, sessionId);
    console.log(`[DB] 👥 Aggiornati ${npcs.length} NPC per sessione ${sessionId}`);
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

    // 3. PULIZIA DATI DERIVATI (come $riprocessa)
    db.prepare('DELETE FROM inventory WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM quests WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM character_history WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM npc_history WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM world_history WHERE session_id = ?').run(sessionId);
    
    // 🆕 PULIZIA MOSTRI (Bestiario)
    db.prepare('DELETE FROM bestiary WHERE session_id = ?').run(sessionId);

    // 🆕 PULIZIA NPC CREATI IN QUESTA SESSIONE
    db.prepare('DELETE FROM npc_dossier WHERE first_session_id = ?').run(sessionId);

    // 🆕 PULIZIA LUOGHI CREATI IN QUESTA SESSIONE
    db.prepare('DELETE FROM location_atlas WHERE first_session_id = ?').run(sessionId);

    console.log(`[DB] 🧹 Dati derivati (inclusi NPC/Mostri/Luoghi originali) puliti per sessione ${sessionId}`);

    // 4. RESET STATO FILE
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

export const insertKnowledgeFragment = (
    campaignId: number,
    sessionId: string,
    content: string,
    embedding: number[],
    model: string,
    startTimestamp: number = 0,
    macro: string | null = null,
    micro: string | null = null,
    npcs: string[] = [],
    entityRefs: string[] = [] // 🆕 Entity Refs (es. ["npc:1", "npc:2", "pc:5"])
) => {
    const npcString = npcs.join(',');
    const entityRefString = entityRefs.length > 0 ? entityRefs.join(',') : null;
    // 🔄 Legacy: Estrai anche gli ID numerici per retrocompatibilità
    const legacyNpcIds = entityRefs
        .filter(ref => ref.startsWith('npc:'))
        .map(ref => ref.replace('npc:', ''))
        .join(',') || null;

    db.prepare(`
        INSERT INTO knowledge_fragments (campaign_id, session_id, content, embedding_json, embedding_model, vector_dimension, start_timestamp, created_at, macro_location, micro_location, associated_npcs, associated_npc_ids, associated_entity_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(campaignId, sessionId, content, JSON.stringify(embedding), model, embedding.length, startTimestamp, Date.now(), macro, micro, npcString, legacyNpcIds, entityRefString);
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
    db.exec('DROP TABLE IF EXISTS pending_merges');

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
        current_year INTEGER,
        allow_auto_character_update INTEGER DEFAULT 0
    )`);

    // --- TABELLA PERSONAGGI ---
    db.exec(`CREATE TABLE IF NOT EXISTS characters (
        user_id TEXT NOT NULL,
        campaign_id INTEGER NOT NULL,
        character_name TEXT,
        race TEXT,
        class TEXT,
        description TEXT,
        rag_sync_needed INTEGER DEFAULT 0,
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
        associated_npc_ids TEXT,
        associated_entity_ids TEXT,
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
        rag_sync_needed INTEGER DEFAULT 0,
        first_session_id TEXT,
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
        rag_sync_needed INTEGER DEFAULT 0,
        aliases TEXT,
        first_session_id TEXT,
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
        session_id TEXT,
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
        session_id TEXT,
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
        rag_sync_needed INTEGER DEFAULT 0,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);

    // --- TABELLA PENDING MERGES ---
    db.exec(`CREATE TABLE IF NOT EXISTS pending_merges (
        message_id TEXT PRIMARY KEY,
        campaign_id INTEGER,
        detected_name TEXT,
        target_name TEXT,
        new_description TEXT,
        role TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
