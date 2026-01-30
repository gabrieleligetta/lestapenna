import { db } from './client';

export const initDatabase = () => {
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
        allow_auto_character_update INTEGER DEFAULT 0,
        last_session_number INTEGER DEFAULT 0
    )`);

    // Migrazione: aggiungi colonna se non esiste
    try {
        db.exec(`ALTER TABLE campaigns ADD COLUMN last_session_number INTEGER DEFAULT 0`);
    } catch (e) { /* colonna già esistente */ }

    // --- TABELLA PERSONAGGI ---
    db.exec(`CREATE TABLE IF NOT EXISTS characters (
        user_id TEXT NOT NULL,
        campaign_id INTEGER NOT NULL,
        character_name TEXT,
        race TEXT,
        class TEXT,
        description TEXT,
        foundation_description TEXT,
        rag_sync_needed INTEGER DEFAULT 0,
        last_synced_history_id INTEGER DEFAULT 0,
        is_manual INTEGER DEFAULT 0,
        PRIMARY KEY (user_id, campaign_id),
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);

    // Migrazione: aggiungi colonna se non esiste
    try {
        db.exec(`ALTER TABLE characters ADD COLUMN last_synced_history_id INTEGER DEFAULT 0`);
    } catch (e) { /* colonna già esistente */ }

    try {
        db.exec(`ALTER TABLE characters ADD COLUMN foundation_description TEXT`);
    } catch (e) { /* colonna già esistente */ }

    // --- TABELLA STORIA PERSONAGGI (BIOGRAFIA) ---
    db.exec(`CREATE TABLE IF NOT EXISTS character_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        character_name TEXT NOT NULL,
        session_id TEXT,
        event_type TEXT, -- 'BACKGROUND', 'TRAUMA', 'RELATIONSHIP', 'ACHIEVEMENT', 'GOAL_CHANGE'
        description TEXT NOT NULL,
        timestamp INTEGER,
        is_manual INTEGER DEFAULT 0,
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
        is_manual INTEGER DEFAULT 0,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);

    // --- TABELLA STORIA DEL MONDO (TIMELINE) ---
    db.exec(`CREATE TABLE IF NOT EXISTS world_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        session_id TEXT,
        event_type TEXT, -- 'WAR', 'POLITICS', 'DISCOVERY', 'CALAMITY', 'SUPERNATURAL', 'GENERIC'
        description TEXT NOT NULL,
        year INTEGER,
        timestamp INTEGER,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        rag_sync_needed INTEGER DEFAULT 0,
        is_manual INTEGER DEFAULT 0,
        short_id TEXT, -- 🆕 Stable ID
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
        processing_phase TEXT DEFAULT 'IDLE',
        phase_started_at INTEGER,
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
        reason TEXT, -- 🆕 Motivo spostamento
        session_date TEXT,
        session_id TEXT,
        timestamp INTEGER,
        is_manual INTEGER DEFAULT 0,
        short_id TEXT, -- 🆕 Stable ID
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
        last_updated_session_id TEXT, -- 🆕 Tracciamento ultima modifica
        is_manual INTEGER DEFAULT 0,
        short_id TEXT, -- 🆕 Stable ID
        UNIQUE(campaign_id, macro_location, micro_location)
    )`);

    // --- TABELLA STORIA ATLANTE ---
    db.exec(`CREATE TABLE IF NOT EXISTS atlas_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        macro_location TEXT,
        micro_location TEXT,
        description TEXT NOT NULL,
        event_type TEXT, -- 'OBSERVATION', 'EVENT', 'MANUAL_UPDATE'
        session_id TEXT,
        timestamp INTEGER,
        is_manual INTEGER DEFAULT 0,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_atlas_history_loc ON atlas_history (campaign_id, macro_location, micro_location)`);

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
        is_manual INTEGER DEFAULT 0,
        short_id TEXT, -- 🆕 Stable ID
        UNIQUE(campaign_id, name)
    )`);

    // --- TABELLA QUESTS ---
    db.exec(`CREATE TABLE IF NOT EXISTS quests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT, -- 🆕 Narrative Journal
        status TEXT DEFAULT 'OPEN', -- OPEN, COMPLETED, FAILED
        type TEXT DEFAULT 'MAJOR', -- 🆕 MAJOR, MINOR
        created_at INTEGER,
        last_updated INTEGER,
        session_id TEXT,
        is_manual INTEGER DEFAULT 0,
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
        is_manual INTEGER DEFAULT 0,
        short_id TEXT, -- 🆕 Stable ID
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
        is_manual INTEGER DEFAULT 0,
        short_id TEXT, -- 🆕 Stable ID
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

    // --- TABELLA STORIA QUEST ---
    db.exec(`CREATE TABLE IF NOT EXISTS quest_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        quest_title TEXT NOT NULL,
        session_id TEXT,
        event_type TEXT, -- 'PROGRESS', 'COMPLETION', 'FAILURE', 'MANUAL_UPDATE'
        description TEXT NOT NULL,
        timestamp INTEGER,
        is_manual INTEGER DEFAULT 0,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_quest_history_title ON quest_history (campaign_id, quest_title)`);

    // --- TABELLA STORIA BESTIARIO ---
    db.exec(`CREATE TABLE IF NOT EXISTS bestiary_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        monster_name TEXT NOT NULL,
        session_id TEXT,
        event_type TEXT, -- 'ENCOUNTER', 'OBSERVATION', 'AUTOPSY', 'MANUAL_UPDATE'
        description TEXT NOT NULL,
        timestamp INTEGER,
        is_manual INTEGER DEFAULT 0,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bestiary_history_name ON bestiary_history (campaign_id, monster_name)`);

    // --- TABELLA STORIA INVENTARIO ---
    db.exec(`CREATE TABLE IF NOT EXISTS inventory_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        item_name TEXT NOT NULL,
        session_id TEXT,
        event_type TEXT, -- 'LOOT', 'USE', 'DAMAGE', 'SALE', 'MANUAL_UPDATE'
        description TEXT NOT NULL,
        timestamp INTEGER,
        is_manual INTEGER DEFAULT 0,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_history_name ON inventory_history (campaign_id, item_name)`);

    // --- TABELLA LOG SESSIONE (RIASSUNTO EVENTI) ---
    db.exec(`CREATE TABLE IF NOT EXISTS session_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_session_logs_session ON session_logs (session_id)`);

    // --- TABELLA FAZIONI ---
    db.exec(`CREATE TABLE IF NOT EXISTS factions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        type TEXT DEFAULT 'GENERIC', -- PARTY, GUILD, KINGDOM, CULT, ORGANIZATION, GENERIC
        leader_npc_id INTEGER,       -- FK opzionale a npc_dossier
        headquarters_location_id INTEGER, -- FK opzionale a location_atlas
        status TEXT DEFAULT 'ACTIVE', -- ACTIVE, DISBANDED, DESTROYED
        is_party INTEGER DEFAULT 0,  -- Flag per fazione party (solo 1 per campagna)
        first_session_id TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        rag_sync_needed INTEGER DEFAULT 0,
        is_manual INTEGER DEFAULT 0,
        short_id TEXT,
        UNIQUE(campaign_id, name),
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_factions_campaign ON factions (campaign_id)`);

    // --- TABELLA REPUTAZIONE PARTY<->FAZIONE ---
    db.exec(`CREATE TABLE IF NOT EXISTS faction_reputation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        faction_id INTEGER NOT NULL,
        reputation TEXT DEFAULT 'NEUTRALE', -- OSTILE, DIFFIDENTE, FREDDO, NEUTRALE, CORDIALE, AMICHEVOLE, ALLEATO
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(campaign_id, faction_id),
        FOREIGN KEY(faction_id) REFERENCES factions(id) ON DELETE CASCADE,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);

    // --- TABELLA AFFILIAZIONI (NPC/Luoghi/PG -> Fazioni) - MANY-TO-MANY ---
    db.exec(`CREATE TABLE IF NOT EXISTS faction_affiliations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        faction_id INTEGER NOT NULL,
        entity_type TEXT NOT NULL,   -- 'npc', 'location', 'pc'
        entity_id INTEGER NOT NULL,
        role TEXT DEFAULT 'MEMBER',  -- LEADER, MEMBER, ALLY, ENEMY, CONTROLLED
        joined_session_id TEXT,      -- Quando è entrato
        is_active INTEGER DEFAULT 1, -- Affiliazione ancora attiva?
        notes TEXT,
        UNIQUE(faction_id, entity_type, entity_id),
        FOREIGN KEY(faction_id) REFERENCES factions(id) ON DELETE CASCADE
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_faction_affiliations_faction ON faction_affiliations (faction_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_faction_affiliations_entity ON faction_affiliations (entity_type, entity_id)`);

    // --- TABELLA STORIA FAZIONI ---
    db.exec(`CREATE TABLE IF NOT EXISTS faction_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        faction_name TEXT NOT NULL,
        session_id TEXT,
        event_type TEXT, -- 'REPUTATION_CHANGE', 'MEMBER_JOIN', 'MEMBER_LEAVE', 'CONFLICT', 'ALLIANCE', 'DISSOLUTION'
        description TEXT NOT NULL,
        timestamp INTEGER,
        is_manual INTEGER DEFAULT 0,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_faction_history_name ON faction_history (campaign_id, faction_name)`);

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
        "ALTER TABLE location_atlas ADD COLUMN first_session_id TEXT",
        // 🆕 BESTIARIO ESTESO (dettagli mostri)
        "ALTER TABLE bestiary ADD COLUMN description TEXT",
        "ALTER TABLE bestiary ADD COLUMN abilities TEXT",      // JSON array: ["Attacco multiplo", "Soffio di fuoco"]
        "ALTER TABLE bestiary ADD COLUMN weaknesses TEXT",     // JSON array: ["Fuoco", "Luce"]
        "ALTER TABLE bestiary ADD COLUMN resistances TEXT",    // JSON array: ["Freddo", "Necrotico"]
        "ALTER TABLE bestiary ADD COLUMN notes TEXT",          // Note libere
        "ALTER TABLE bestiary ADD COLUMN first_session_id TEXT",
        // 🆕 INVENTARIO ESTESO
        "ALTER TABLE inventory ADD COLUMN description TEXT",
        "ALTER TABLE inventory ADD COLUMN notes TEXT",
        // 🆕 SESSION PHASE TRACKING (Crash Recovery)
        "ALTER TABLE sessions ADD COLUMN processing_phase TEXT DEFAULT 'IDLE'",
        "ALTER TABLE sessions ADD COLUMN phase_started_at INTEGER",
        // 🆕 PERSISTENT SESSION COUNTER PER CAMPAIGN
        "ALTER TABLE campaigns ADD COLUMN last_session_number INTEGER DEFAULT 0",
        // 🆕 TRACCIAMENTO ULTIMA SESSIONE CHE HA MODIFICATO (per purge pulito)
        "ALTER TABLE npc_dossier ADD COLUMN last_updated_session_id TEXT",
        "ALTER TABLE location_atlas ADD COLUMN last_updated_session_id TEXT",
        // 🆕 UNIFIED BIO FLOW: Storia per Atlante
        "CREATE TABLE IF NOT EXISTS atlas_history (id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, macro_location TEXT, micro_location TEXT, description TEXT NOT NULL, event_type TEXT, session_id TEXT, timestamp INTEGER, FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE)",
        "CREATE INDEX IF NOT EXISTS idx_atlas_history_loc ON atlas_history (campaign_id, macro_location, micro_location)",
        // 🆕 PHASE 2: Rag Sync per tutti
        "ALTER TABLE quests ADD COLUMN rag_sync_needed INTEGER DEFAULT 0",
        "ALTER TABLE bestiary ADD COLUMN rag_sync_needed INTEGER DEFAULT 0",
        "ALTER TABLE inventory ADD COLUMN rag_sync_needed INTEGER DEFAULT 0",
        // 🆕 PHASE 2: Description for Quests
        "ALTER TABLE quests ADD COLUMN description TEXT",
        // 🆕 SESSION LOGS (Bullet points)
        "CREATE TABLE IF NOT EXISTS session_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, content TEXT NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE)",
        "CREATE INDEX IF NOT EXISTS idx_session_logs_session ON session_logs (session_id)",
        // 🆕 TRAVEL REASONS
        "ALTER TABLE location_history ADD COLUMN reason TEXT",
        // 🆕 PERSISTENCE & REPLAY
        "ALTER TABLE sessions ADD COLUMN analyst_data TEXT",
        "ALTER TABLE sessions ADD COLUMN summary_data TEXT",
        "ALTER TABLE sessions ADD COLUMN last_generated_at INTEGER",
        // 🆕 BESTIARIO: Supporto per varianti e deduplicazione
        "ALTER TABLE bestiary ADD COLUMN variants TEXT",      // JSON array di nomi varianti es. ["Goblin Arciere", "Goblin Sciamano"]
        // 🆕 QUEST TYPE: Granularità
        "ALTER TABLE quests ADD COLUMN type TEXT DEFAULT 'MAJOR'",
        // 🆕 USER INPUT PROTECTION
        "ALTER TABLE characters ADD COLUMN is_manual INTEGER DEFAULT 0",
        "ALTER TABLE character_history ADD COLUMN is_manual INTEGER DEFAULT 0",
        "ALTER TABLE npc_dossier ADD COLUMN is_manual INTEGER DEFAULT 0",
        "ALTER TABLE npc_history ADD COLUMN is_manual INTEGER DEFAULT 0",
        "ALTER TABLE location_atlas ADD COLUMN is_manual INTEGER DEFAULT 0",
        "ALTER TABLE location_history ADD COLUMN is_manual INTEGER DEFAULT 0",
        "ALTER TABLE atlas_history ADD COLUMN is_manual INTEGER DEFAULT 0",
        "ALTER TABLE world_history ADD COLUMN is_manual INTEGER DEFAULT 0",
        "ALTER TABLE quests ADD COLUMN is_manual INTEGER DEFAULT 0",
        "ALTER TABLE quest_history ADD COLUMN is_manual INTEGER DEFAULT 0",
        "ALTER TABLE bestiary ADD COLUMN is_manual INTEGER DEFAULT 0",
        "ALTER TABLE bestiary_history ADD COLUMN is_manual INTEGER DEFAULT 0",
        "ALTER TABLE inventory ADD COLUMN is_manual INTEGER DEFAULT 0",
        "ALTER TABLE inventory_history ADD COLUMN is_manual INTEGER DEFAULT 0",
        // 🆕 UNIVERSAL STABLE IDs (Short IDs)
        "ALTER TABLE npc_dossier ADD COLUMN short_id TEXT",
        "ALTER TABLE location_atlas ADD COLUMN short_id TEXT",
        "ALTER TABLE quests ADD COLUMN short_id TEXT",
        "ALTER TABLE bestiary ADD COLUMN short_id TEXT",
        "ALTER TABLE inventory ADD COLUMN short_id TEXT",
        "ALTER TABLE location_history ADD COLUMN short_id TEXT",
        "ALTER TABLE world_history ADD COLUMN short_id TEXT",
        "ALTER TABLE world_history ADD COLUMN timestamp INTEGER",
        "ALTER TABLE characters ADD COLUMN foundation_description TEXT"
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

    // --- MIGRATION: DEDUPLICAZIONE BESTIARIO ---
    try {
        // Verifica se dobbiamo migrare: se esiste il vecchio indice e NON quello nuovo
        const oldIndex = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_bestiary_unique'").get();
        const newIndex = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_bestiary_unique_global'").get();

        if (oldIndex && !newIndex) {
            console.log("[Migration] 🔄 Inizio deduplicazione Bestiario...");

            // 1. Recupera tutti i mostri ordinati per ultima vista (il primo sarà il master)
            const monsters = db.prepare("SELECT * FROM bestiary ORDER BY campaign_id, name, last_seen DESC").all() as any[];
            const grouped = new Map<string, any[]>();

            for (const m of monsters) {
                const key = `${m.campaign_id}:${m.name.toLowerCase()}`;
                if (!grouped.has(key)) grouped.set(key, []);
                grouped.get(key)!.push(m);
            }

            const migrationTx = db.transaction(() => {
                let mergedCount = 0;
                for (const [key, group] of grouped) {
                    if (group.length > 1) {
                        const master = group[0]; // Il più recente

                        // Set per merge univoci
                        const mergedAbilities = new Set<string>();
                        const mergedWeaknesses = new Set<string>();
                        const mergedResistances = new Set<string>();
                        let mergedNotes = master.notes || '';

                        // Popola dal master
                        try { JSON.parse(master.abilities || '[]').forEach((x: string) => mergedAbilities.add(x)); } catch { }
                        try { JSON.parse(master.weaknesses || '[]').forEach((x: string) => mergedWeaknesses.add(x)); } catch { }
                        try { JSON.parse(master.resistances || '[]').forEach((x: string) => mergedResistances.add(x)); } catch { }

                        // Merge degli altri
                        for (let i = 1; i < group.length; i++) {
                            const duplicate = group[i];
                            try { JSON.parse(duplicate.abilities || '[]').forEach((x: string) => mergedAbilities.add(x)); } catch { }
                            try { JSON.parse(duplicate.weaknesses || '[]').forEach((x: string) => mergedWeaknesses.add(x)); } catch { }
                            try { JSON.parse(duplicate.resistances || '[]').forEach((x: string) => mergedResistances.add(x)); } catch { }

                            if (duplicate.notes && !mergedNotes.includes(duplicate.notes)) {
                                mergedNotes += `\n[Da Sessione ${duplicate.session_id || '?'}]: ${duplicate.notes}`;
                            }

                            // Elimina duplicato
                            db.prepare("DELETE FROM bestiary WHERE id = ?").run(duplicate.id);
                        }

                        // Aggiorna master
                        db.prepare(`
                            UPDATE bestiary 
                            SET abilities = ?, weaknesses = ?, resistances = ?, notes = ?
                            WHERE id = ?
                        `).run(
                            JSON.stringify([...mergedAbilities]),
                            JSON.stringify([...mergedWeaknesses]),
                            JSON.stringify([...mergedResistances]),
                            mergedNotes.trim(),
                            master.id
                        );
                        mergedCount++;
                    }
                }

                console.log(`[Migration] 🔗 Unificati ${mergedCount} gruppi di mostri duplicati.`);

                // Drop e Create Index
                db.prepare("DROP INDEX IF EXISTS idx_bestiary_unique").run();
                db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_bestiary_unique_global ON bestiary(campaign_id, name)").run();
            });

            migrationTx();
            console.log("[Migration] ✅ Deduplicazione Bestiario completata con successo.");
        }
    } catch (e) {
        console.error("[Migration] ❌ Errore critico migrazione bestiario:", e);
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
};
