import { db } from './client';

/**
 * Baseline schema.
 *
 * There is no migration history: the schema is a single snapshot of the current
 * state, and `initDatabase()` applies it idempotently (`IF NOT EXISTS`
 * everywhere) both to an empty database and to an already populated one.
 *
 * Adding a column to an existing table is therefore NOT a change to the DDL
 * below alone: an already created database would never see it. It needs an
 * idempotent `ALTER TABLE` in `SCHEMA_UPGRADES`, on top of the column in the
 * `CREATE TABLE` for fresh installations.
 */

/** 44 tables. */
const TABLES: string[] = [
    /*
     * On-demand AI work, from the click to the outcome.
     *
     * It exists because a paid action used to live inside an HTTP request and a
     * process-local `Map`: a dropped connection, a closed tab or a redeploy threw
     * away work the table had already been charged for, and left nowhere to read
     * that it had happened. A row here is created before the provider is called
     * and outlives the request, the browser and the container.
     *
     * Two invariants are worth stating because the columns encode them:
     *
     *  - **Nothing here is ever retried automatically.** There is no `attempts`
     *    column, deliberately: a retry on a paid call is a second charge on
     *    somebody's own provider account. Retrying is a person pressing the
     *    button again, which makes a new row.
     *  - **`usage_run_id IS NOT NULL` means the provider was paid**, because it
     *    is written the moment the call returns and before anything else. It is
     *    also the only link to the money: the ledger stays `ai_usage_log`, and a
     *    copy of the cost here would be a second figure free to disagree with it.
     */
    `CREATE TABLE IF NOT EXISTS ai_job (
        id TEXT PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('image', 'appearance', 'quest-audit', 'character-bio')),
        -- 'campaign' is the target of a quest audit. No NULLs on purpose: SQLite
        -- treats NULLs as distinct in a unique index, so a nullable target would
        -- quietly disable the one-active-job rule for exactly the kind that has
        -- no entity.
        target_type TEXT NOT NULL CHECK(target_type IN ('npc', 'location', 'character', 'artifact', 'campaign')),
        -- The public short id, never the internal row id: it is what the URL
        -- carries, what the prompt builder looks entities up by, and the only one
        -- of the two that survives a merge without silently retargeting the job.
        target_key TEXT NOT NULL,
        -- The name as it read when the work was asked for, so the notification can
        -- say "Astrid Foe" without resolving an entity that may since be gone.
        target_label TEXT,
        requested_by TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
            'queued', 'running', 'awaiting_review', 'succeeded', 'discarded', 'failed', 'expired')),
        -- The exact input. The runner executes after the HTTP response has been
        -- sent, so mode, prompt, framing and chosen references have to be durable.
        params_json TEXT NOT NULL,
        result_json TEXT,
        -- Columns rather than fields inside result_json: the sweeper deletes these
        -- objects in plain SQL, and json_extract in a janitor is how orphans start.
        result_original_key TEXT,
        result_display_key TEXT,
        error_kind TEXT CHECK(error_kind IS NULL OR error_kind IN (
            'refused', 'reference', 'not_configured', 'provider', 'storage', 'interrupted', 'internal')),
        error_message TEXT,
        provider TEXT,
        model TEXT,
        -- The only trace of a call whose model has no published price: in that
        -- case nothing is written to ai_usage_log at all.
        pricing_available INTEGER,
        usage_run_id TEXT,
        -- NULL means the requester has not seen the outcome yet. One column and
        -- not a per-user table because the bell shows a person their own work.
        seen_at INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        -- Only for a result waiting to be accepted; days, not minutes, because
        -- the bytes are already paid for and sitting in a bucket.
        expires_at INTEGER,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS ai_usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        guild_id TEXT,
        campaign_id INTEGER,
        phase TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        input_price_per_million REAL,
        output_price_per_million REAL,
        cached_input_price_per_million REAL,
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    , cost_eur REAL, usd_per_eur REAL, exchange_rate_source TEXT, exchange_rate_date TEXT, exchange_rate_fetched_at INTEGER, pricing_source TEXT)`,
    `CREATE TABLE IF NOT EXISTS artifact_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        artifact_name TEXT NOT NULL,
        session_id TEXT,
        event_type TEXT, -- 'DISCOVERY', 'ACTIVATION', 'CURSE_REVEAL', 'DESTRUCTION', 'TRANSFER', 'OBSERVATION', 'MANUAL_UPDATE'
        description TEXT NOT NULL,
        timestamp INTEGER,
        is_manual INTEGER DEFAULT 0, entity_id INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS "artifacts" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        effects TEXT,                    -- Cosa fa l'artefatto
        is_cursed INTEGER DEFAULT 0,     -- Flag maledizione
        curse_description TEXT,          -- Descrizione maledizione
        owner_type TEXT,                 -- PC, NPC, FACTION, LOCATION, NONE
        owner_id INTEGER,                -- FK dinamica
        owner_name TEXT,                 -- Denormalizzato
        location_macro TEXT,             -- Dove si trova
        location_micro TEXT,
        faction_id INTEGER,              -- FK a factions
        status TEXT DEFAULT 'FUNZIONANTE', -- FUNZIONANTE, DISTRUTTO, PERDUTO, SIGILLATO, DORMIENTE
        first_session_id TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        rag_sync_needed INTEGER DEFAULT 0,
        is_manual INTEGER DEFAULT 0,
        short_id TEXT, manual_description TEXT,
        UNIQUE(campaign_id, name COLLATE NOCASE),
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS ask_conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            campaign_id INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            title TEXT NOT NULL,
            shared INTEGER NOT NULL DEFAULT 0 CHECK(shared IN (0, 1)),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
        )`,
    `CREATE TABLE IF NOT EXISTS ask_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    cost_usd REAL,
    cost_eur REAL,
    provider TEXT,
    model TEXT,
    FOREIGN KEY(conversation_id) REFERENCES ask_conversations(id) ON DELETE CASCADE
)`,
    `CREATE TABLE IF NOT EXISTS atlas_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        macro_location TEXT,
        micro_location TEXT,
        description TEXT NOT NULL,
        event_type TEXT, -- 'OBSERVATION', 'EVENT', 'MANUAL_UPDATE'
        session_id TEXT,
        timestamp INTEGER, is_manual INTEGER DEFAULT 0,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS bestiary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'ALIVE', -- ALIVE, DEFEATED, FLED
    session_id TEXT, -- Sessione in cui è stato incontrato
    last_seen INTEGER, description TEXT, abilities TEXT, weaknesses TEXT, resistances TEXT, notes TEXT, first_session_id TEXT, rag_sync_needed INTEGER DEFAULT 0, variants TEXT, is_manual INTEGER DEFAULT 0, short_id TEXT, manual_description TEXT, -- Timestamp ultimo avvistamento
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
)`,
    `CREATE TABLE IF NOT EXISTS bestiary_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        monster_name TEXT NOT NULL,
        session_id TEXT,
        event_type TEXT, -- 'ENCOUNTER', 'OBSERVATION', 'AUTOPSY', 'MANUAL_UPDATE'
        description TEXT NOT NULL,
        timestamp INTEGER, is_manual INTEGER DEFAULT 0, entity_id INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS campaign_members (
        campaign_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'PLAYER' CHECK(role IN ('MASTER', 'PLAYER')),
        added_at INTEGER,
        PRIMARY KEY (campaign_id, user_id),
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    is_active INTEGER DEFAULT 0,
    created_at INTEGER
, current_location TEXT, current_macro_location TEXT, current_micro_location TEXT, current_year INTEGER, allow_auto_character_update INTEGER DEFAULT 0, last_session_number INTEGER DEFAULT 0, party_alignment_moral TEXT DEFAULT 'NEUTRALE', party_alignment_ethical TEXT DEFAULT 'NEUTRALE', party_moral_score INTEGER DEFAULT 0, party_ethical_score INTEGER DEFAULT 0, language TEXT, embedding_model TEXT, embedding_dimension INTEGER, art_direction TEXT, tarot_arcana TEXT, cover_object_key TEXT, cover_thumbnail_key TEXT, cover_updated_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS character_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    character_name TEXT NOT NULL,
    session_id TEXT,
    event_type TEXT, -- 'BACKGROUND', 'TRAUMA', 'RELATIONSHIP', 'ACHIEVEMENT', 'GOAL_CHANGE'
    description TEXT NOT NULL,
    timestamp INTEGER, is_manual INTEGER DEFAULT 0, moral_weight INTEGER DEFAULT 0, ethical_weight INTEGER DEFAULT 0, faction_id INTEGER REFERENCES factions(id) ON DELETE SET NULL,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
)`,
    `CREATE TABLE IF NOT EXISTS characters (
    user_id TEXT NOT NULL,
    campaign_id INTEGER NOT NULL,
    character_name TEXT,
    race TEXT,
    class TEXT,
    description TEXT, rag_sync_needed INTEGER DEFAULT 0, last_synced_history_id INTEGER DEFAULT 0, is_manual INTEGER DEFAULT 0, foundation_description TEXT, alignment_moral TEXT, alignment_ethical TEXT, email TEXT, moral_score INTEGER DEFAULT 0, ethical_score INTEGER DEFAULT 0, manual_description TEXT,
    PRIMARY KEY (user_id, campaign_id),
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
)`,
    /*
     * The verbatim `$ask` exchanges.
     *
     * `guild_id` and `user_id` are not there to query by: they are there so the
     * rows can be *deleted*. Keyed on the channel alone, this table was
     * unreachable from any erasure — neither «forget me» nor «the bot was
     * removed from this server» could find its own rows in it, while it holds
     * the most literal personal data in the database.
     */
    `CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER
, guild_id TEXT, user_id TEXT)`,
    `CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
)`,
    `CREATE TABLE IF NOT EXISTS entity_media (
        id TEXT PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        entity_type TEXT NOT NULL CHECK(entity_type IN ('npc', 'location', 'character', 'artifact')),
        entity_key TEXT NOT NULL,
        display_object_key TEXT NOT NULL,
        thumbnail_object_key TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        focal_x REAL NOT NULL DEFAULT 50 CHECK(focal_x >= 0 AND focal_x <= 100),
        focal_y REAL NOT NULL DEFAULT 50 CHECK(focal_y >= 0 AND focal_y <= 100),
        alt_text TEXT,
        -- 'upload' | 'ai'. The is_manual guard for media: a picture put there by
        -- hand is never replaced by a generated one without an explicit action.
        source TEXT NOT NULL DEFAULT 'upload',
        -- 'auto' | 'prompt' | 'mixed', and the two prompts behind a generated
        -- image: what reached the provider, and what the person actually typed.
        -- The second is the one worth showing back, editing and running again —
        -- keeping only the expanded one would dissolve the human request into
        -- machine prose and make "generate it again the same way" impossible.
        generation_mode TEXT,
        generation_prompt TEXT,
        generation_user_prompt TEXT,
        -- The complete provider-neutral request and this picture's defaults
        -- when it is used as a visual reference in a later generation.
        generation_request_json TEXT,
        reference_roles_json TEXT,
        reference_instruction TEXT,
        reference_auto_select INTEGER NOT NULL DEFAULT 0,
        -- Exactly one row per entity carries a 1: the picture the sheet shows.
        -- The rest are the gallery, and are still drawn from as references.
        is_primary INTEGER NOT NULL DEFAULT 1,
        uploaded_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`,
    /*
     * What an entity looks like, and how it behaves — mined from the campaign's
     * own material and kept as structured traits rather than prose.
     *
     * It exists because a picture drawn straight from a chat answer is a picture
     * of an invention: asked to describe an NPC whose records hold no physical
     * detail, a model will supply one. Here every trait carries the evidence it
     * came from, a trait with no evidence is dropped before it is ever stored,
     * and what a person edits by hand (`is_manual`) is never overwritten.
     *
     * `appearance_json` is the part the image prompt is assembled from, field by
     * field, so nothing can paraphrase "white hair" away between the record and
     * the drawing. `appearance_text` is the same content rendered for a reader.
     */
    `CREATE TABLE IF NOT EXISTS entity_profile (
        id TEXT PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        entity_type TEXT NOT NULL CHECK(entity_type IN ('npc', 'location', 'character', 'artifact')),
        -- The public short id, the one in the URL — not the internal row id.
        entity_key TEXT NOT NULL,
        appearance_json TEXT,
        appearance_text TEXT,
        personality_text TEXT,
        -- Per trait: what was said, where, and in which session.
        evidence_json TEXT,
        confidence TEXT CHECK(confidence IS NULL OR confidence IN ('HIGH', 'MEDIUM', 'LOW')),
        is_manual INTEGER NOT NULL DEFAULT 0,
        -- Which fields a person filled in by hand, as a JSON array of paths.
        -- Per field rather than per record so that writing one line yourself
        -- does not freeze the whole dossier: a later analysis fills what you
        -- left alone and keeps what you wrote.
        manual_fields TEXT,
        provider TEXT,
        model TEXT,
        generated_at INTEGER,
        -- Set when a session later than the analysis mentions the entity: the
        -- dossier says so, and still never spends anything on its own.
        stale_since_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(campaign_id, entity_type, entity_key),
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`,
    /*
     * Pictures handed to the image model as references.
     *
     * Three scopes, because the look of a portrait comes from three places that
     * are not the same record: the campaign's art direction (the gallery should
     * look like one world), a faction's livery (Astrid wears the armour of the
     * Dame di Ferro because of who she serves, and that armour is described on
     * the faction), and the entity's own accepted portrait — attached back on a
     * regeneration so the face survives it.
     *
     * Deliberately not `entity_media`: that table holds one row per entity and
     * its CHECK has no room for a faction or a whole campaign.
     */
    `CREATE TABLE IF NOT EXISTS reference_image (
        id TEXT PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('campaign', 'faction', 'entity')),
        -- Empty for 'campaign'; the faction short id, or "<type>:<short id>".
        scope_key TEXT NOT NULL DEFAULT '',
        object_key TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        label TEXT,
        roles_json TEXT,
        instruction TEXT,
        auto_select INTEGER NOT NULL DEFAULT 1,
        uploaded_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`,
    /*
     * A picture handed to one generation only.
     *
     * It is durable because the generation itself is a durable asynchronous
     * job: keeping these bytes in a process Map made a queued job lose its
     * selected reference on every restart. The janitor deletes expired objects
     * and rows, while `job_id` prevents one scratch upload being reused by two
     * paid requests.
     */
    `CREATE TABLE IF NOT EXISTS image_reference_scratch (
        id TEXT PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        object_key TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        label TEXT,
        roles_json TEXT,
        instruction TEXT,
        uploaded_by TEXT NOT NULL,
        job_id TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
        FOREIGN KEY(job_id) REFERENCES ai_job(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS faction_affiliations (
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
    )`,
    `CREATE TABLE IF NOT EXISTS faction_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        faction_name TEXT NOT NULL,
        session_id TEXT,
        event_type TEXT, -- 'REPUTATION_CHANGE', 'MEMBER_JOIN', 'MEMBER_LEAVE', 'CONFLICT', 'ALLIANCE', 'DISSOLUTION'
        description TEXT NOT NULL,
        timestamp INTEGER,
        is_manual INTEGER DEFAULT 0, reputation_change_value INTEGER DEFAULT 0, moral_weight INTEGER DEFAULT 0, ethical_weight INTEGER DEFAULT 0, entity_id INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS faction_reputation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        faction_id INTEGER NOT NULL,
        reputation TEXT DEFAULT 'NEUTRALE', -- OSTILE, DIFFIDENTE, FREDDO, NEUTRALE, CORDIALE, AMICHEVOLE, ALLEATO
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP, reputation_score INTEGER DEFAULT 0,
        UNIQUE(campaign_id, faction_id),
        FOREIGN KEY(faction_id) REFERENCES factions(id) ON DELETE CASCADE,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS factions (
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
        short_id TEXT, alignment_moral TEXT, alignment_ethical TEXT, moral_score INTEGER DEFAULT 0, ethical_score INTEGER DEFAULT 0, manual_description TEXT,
        UNIQUE(campaign_id, name),
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    acquired_at INTEGER,
    last_updated INTEGER, session_id TEXT, description TEXT, notes TEXT, rag_sync_needed INTEGER DEFAULT 0, is_manual INTEGER DEFAULT 0, short_id TEXT, manual_description TEXT, category TEXT NOT NULL DEFAULT 'OTHER',
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
)`,
    `CREATE TABLE IF NOT EXISTS inventory_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        item_name TEXT NOT NULL,
        session_id TEXT,
        event_type TEXT, -- 'LOOT', 'USE', 'DAMAGE', 'SALE', 'MANUAL_UPDATE'
        description TEXT NOT NULL,
        timestamp INTEGER, is_manual INTEGER DEFAULT 0, entity_id INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS knowledge_fragments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    session_id TEXT,
    content TEXT NOT NULL,
    embedding_json TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    vector_dimension INTEGER,
    start_timestamp INTEGER,
    created_at INTEGER, macro_location TEXT, micro_location TEXT, associated_npcs TEXT, associated_npc_ids TEXT, associated_entity_ids TEXT, embedding BLOB,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
)`,
    `CREATE TABLE IF NOT EXISTS legal_acceptances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_user_id TEXT NOT NULL,
        document TEXT NOT NULL,
        version TEXT NOT NULL,
        accepted_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS "location_atlas" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    macro_location TEXT NOT NULL,
    micro_location TEXT NOT NULL,
    description TEXT,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP, rag_sync_needed INTEGER DEFAULT 0, first_session_id TEXT, last_updated_session_id TEXT, is_manual INTEGER DEFAULT 0, short_id TEXT, manual_description TEXT,
    UNIQUE(campaign_id, macro_location, micro_location)
, FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS location_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    location TEXT,
    macro_location TEXT,
    micro_location TEXT,
    session_date TEXT,
    timestamp INTEGER, session_id TEXT, reason TEXT, is_manual INTEGER DEFAULT 0, short_id TEXT,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
)`,
    /*
     * The models offered in the settings selects, refreshed periodically.
     *
     * It is a **cache, not a source of truth**: it can be emptied and rebuilt at
     * any time, and when it is empty the curated list committed in
     * `bard/ai/modelCatalog.ts` takes over. That is what keeps an instance
     * without network — a self-hoster behind a firewall — with a working
     * settings page instead of an empty select.
     *
     * `kind` separates two different billing units that must never be confused:
     * `text` is priced per token, `transcription` per minute of audio.
     */
    `CREATE TABLE IF NOT EXISTS model_catalog (
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT,
    tiers TEXT NOT NULL DEFAULT '[]',
    input_per_million REAL,
    output_per_million REAL,
    cached_input_per_million REAL,
    per_minute_usd REAL,
    per_image_usd REAL,
    context_tokens INTEGER,
    max_output_tokens INTEGER,
    release_date TEXT,
    recommended_for TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL,
    refreshed_at INTEGER NOT NULL,
    PRIMARY KEY (provider, model_id, kind)
)`,
    `CREATE TABLE IF NOT EXISTS "npc_dossier" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    role TEXT, -- Es. "Locandiere", "Guardia", "Villain"
    description TEXT,
    status TEXT DEFAULT 'ALIVE', -- ALIVE, DEAD, MISSING
    last_seen_location TEXT, -- Link opzionale al luogo
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP, rag_sync_needed INTEGER DEFAULT 0, aliases TEXT, first_session_id TEXT, last_updated_session_id TEXT, is_manual INTEGER DEFAULT 0, short_id TEXT, alignment_moral TEXT, alignment_ethical TEXT, moral_score INTEGER DEFAULT 0, ethical_score INTEGER DEFAULT 0, manual_description TEXT,
    UNIQUE(campaign_id, name COLLATE NOCASE)
, FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS npc_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    npc_name TEXT NOT NULL,
    session_id TEXT,
    event_type TEXT, -- 'REVELATION', 'BETRAYAL', 'DEATH', 'ALLIANCE', 'STATUS_CHANGE'
    description TEXT NOT NULL,
    timestamp INTEGER, is_manual INTEGER DEFAULT 0, moral_weight INTEGER DEFAULT 0, ethical_weight INTEGER DEFAULT 0, faction_id INTEGER REFERENCES factions(id) ON DELETE SET NULL, entity_id INTEGER,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
)`,
    `CREATE TABLE IF NOT EXISTS pending_merges (
    message_id TEXT PRIMARY KEY,
    campaign_id INTEGER,
    detected_name TEXT,
    target_name TEXT,
    new_description TEXT,
    role TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`,
    `CREATE TABLE IF NOT EXISTS quest_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        quest_title TEXT NOT NULL,
        session_id TEXT,
        event_type TEXT, -- 'PROGRESS', 'COMPLETION', 'FAILURE', 'MANUAL_UPDATE'
        description TEXT NOT NULL,
        timestamp INTEGER, is_manual INTEGER DEFAULT 0, entity_id INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS quest_lifecycle_suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        quest_id INTEGER,
        session_id TEXT,
        proposed_action TEXT NOT NULL CHECK(proposed_action IN ('CREATE', 'STATUS_CHANGE')),
        proposed_title TEXT NOT NULL,
        proposed_description TEXT,
        proposed_status TEXT NOT NULL CHECK(proposed_status IN ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'FAILED')),
        proposed_type TEXT NOT NULL CHECK(proposed_type IN ('MAJOR', 'MINOR')),
        evidence TEXT NOT NULL,
        confidence TEXT NOT NULL CHECK(confidence IN ('HIGH', 'MEDIUM', 'LOW')),
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'APPLIED', 'DISMISSED')),
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
        FOREIGN KEY(quest_id) REFERENCES quests(id) ON DELETE CASCADE,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS quests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    status TEXT DEFAULT 'OPEN', -- OPEN, COMPLETED, FAILED
    created_at INTEGER,
    last_updated INTEGER, session_id TEXT, rag_sync_needed INTEGER DEFAULT 0, description TEXT, type TEXT DEFAULT 'MAJOR', is_manual INTEGER DEFAULT 0, short_id TEXT, manual_description TEXT,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
)`,
    `CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    user_id TEXT,
    timestamp INTEGER,
    status TEXT DEFAULT 'PENDING', 
    transcription_text TEXT,
    error_log TEXT
, macro_location TEXT, micro_location TEXT, present_npcs TEXT, character_name_snapshot TEXT, year INTEGER, raw_transcription_text TEXT)`,
    `CREATE TABLE IF NOT EXISTS session_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS session_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    user_id TEXT,
    content TEXT NOT NULL,
    timestamp INTEGER,
    created_at INTEGER
, macro_location TEXT, micro_location TEXT)`,
    `CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    session_number INTEGER
, guild_id TEXT, campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL, title TEXT, processing_phase TEXT DEFAULT 'IDLE', phase_started_at INTEGER, analyst_data TEXT, summary_data TEXT, last_generated_at INTEGER, audio_mix_warning TEXT)`,
    `CREATE TABLE IF NOT EXISTS tenant_ai_settings (
    scope TEXT NOT NULL DEFAULT 'guild',
    scope_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    settings_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT,
    PRIMARY KEY (scope, scope_id)
)`,
    `CREATE TABLE IF NOT EXISTS tenant_secrets (
    scope TEXT NOT NULL DEFAULT 'guild',
    scope_id TEXT NOT NULL,
    secret_key TEXT NOT NULL,
    ciphertext BLOB NOT NULL,
    iv BLOB NOT NULL,
    auth_tag BLOB NOT NULL,
    key_version INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    hint TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT,
    last_verified_at INTEGER,
    verify_status TEXT,
    verify_error TEXT,
    PRIMARY KEY (scope, scope_id, secret_key)
)`,
    `CREATE TABLE IF NOT EXISTS tenants (
    guild_id TEXT PRIMARY KEY,
    created_at INTEGER,
    admin_discord_id TEXT
)`,
    `CREATE TABLE IF NOT EXISTS usage_tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        month TEXT NOT NULL,
        sessions_used INTEGER DEFAULT 0,
        audio_minutes_used REAL DEFAULT 0,
        ai_cost_usd REAL DEFAULT 0,
        storage_bytes INTEGER DEFAULT 0, ai_cost_eur REAL,
        UNIQUE(guild_id, month)
    )`,
    `CREATE TABLE IF NOT EXISTS users (
    discord_id TEXT PRIMARY KEY,
    character_name TEXT,
    race TEXT,
    class TEXT,
    description TEXT
)`,
    `CREATE TABLE IF NOT EXISTS world_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    session_id TEXT,
    event_type TEXT, -- 'WAR', 'POLITICS', 'DISCOVERY', 'CALAMITY', 'SUPERNATURAL', 'GENERIC'
    description TEXT NOT NULL,
    timestamp INTEGER, year INTEGER, rag_sync_needed INTEGER DEFAULT 0, is_manual INTEGER DEFAULT 0, short_id TEXT, moral_weight INTEGER DEFAULT 0, ethical_weight INTEGER DEFAULT 0,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
)`,
];

/** 53 indici espliciti; quelli di PRIMARY KEY/UNIQUE li crea SQLite. */
const INDEXES: string[] = [
    `CREATE INDEX IF NOT EXISTS idx_ai_job_campaign ON ai_job (campaign_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_ai_job_requester ON ai_job (requested_by, created_at DESC)`,
    /*
     * One active job per target, enforced by the database.
     *
     * This is what replaces the `Set` of in-flight keys each service kept in
     * memory: those were per-process, so a restart forgot them, and the one
     * paid action that never had a lock at all (bio regeneration) charged twice
     * for a double click. A partial unique index cannot be forgotten.
     */
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_job_active ON ai_job (campaign_id, kind, target_type, target_key)
        WHERE status IN ('queued', 'running')`,
    `CREATE INDEX IF NOT EXISTS idx_ai_job_claimable ON ai_job (created_at) WHERE status = 'queued'`,
    `CREATE INDEX IF NOT EXISTS idx_ai_job_expiry ON ai_job (expires_at) WHERE status = 'awaiting_review'`,
    `CREATE INDEX IF NOT EXISTS idx_tenant_secrets_scope ON tenant_secrets (scope, scope_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ai_usage_log_guild ON ai_usage_log (guild_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_ai_usage_log_session ON ai_usage_log (session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_artifact_history_entity ON artifact_history(campaign_id, entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_artifact_history_name ON artifact_history (campaign_id, artifact_name)`,
    `CREATE INDEX IF NOT EXISTS idx_artifacts_campaign ON artifacts (campaign_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ask_conversations_campaign_user
            ON ask_conversations(campaign_id, user_id, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_ask_conversations_shared
            ON ask_conversations(campaign_id, shared, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_ask_messages_conversation ON ask_messages(conversation_id, id)`,
    `CREATE INDEX IF NOT EXISTS idx_atlas_history_loc ON atlas_history (campaign_id, macro_location, micro_location)`,
    `CREATE INDEX IF NOT EXISTS idx_bestiary_campaign ON bestiary (campaign_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_bestiary_unique ON bestiary(campaign_id, name, session_id) WHERE session_id IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_bestiary_unique_global ON bestiary(campaign_id, name)`,
    `CREATE INDEX IF NOT EXISTS idx_bestiary_history_entity ON bestiary_history(campaign_id, entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_bestiary_history_name ON bestiary_history (campaign_id, monster_name)`,
    `CREATE INDEX IF NOT EXISTS idx_campaigns_guild ON campaigns (guild_id)`,
    `CREATE INDEX IF NOT EXISTS idx_char_history_name ON character_history (campaign_id, character_name)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_history_channel ON chat_history (channel_id)`,
    `CREATE INDEX IF NOT EXISTS idx_entity_media_campaign ON entity_media(campaign_id, entity_type, entity_key)`,
    `CREATE INDEX IF NOT EXISTS idx_entity_profile_campaign ON entity_profile(campaign_id, entity_type, entity_key)`,
    `CREATE INDEX IF NOT EXISTS idx_reference_image_scope ON reference_image(campaign_id, scope, scope_key)`,
    `CREATE INDEX IF NOT EXISTS idx_image_reference_scratch_expiry ON image_reference_scratch(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_faction_affiliations_entity ON faction_affiliations (entity_type, entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_faction_affiliations_faction ON faction_affiliations (faction_id)`,
    `CREATE INDEX IF NOT EXISTS idx_faction_history_entity ON faction_history(campaign_id, entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_faction_history_name ON faction_history (campaign_id, faction_name)`,
    `CREATE INDEX IF NOT EXISTS idx_factions_campaign ON factions (campaign_id)`,
    `CREATE INDEX IF NOT EXISTS idx_inventory_campaign ON inventory (campaign_id)`,
    `CREATE INDEX IF NOT EXISTS idx_inventory_campaign_category ON inventory(campaign_id, category, item_name)`,
    `CREATE INDEX IF NOT EXISTS idx_inventory_history_entity ON inventory_history(campaign_id, entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_inventory_history_name ON inventory_history (campaign_id, item_name)`,
    // Append-only register: what matters is always the latest acceptance per
    // document, never the whole history in arbitrary order.
    `CREATE INDEX IF NOT EXISTS idx_legal_acceptances_user ON legal_acceptances (discord_user_id, document, accepted_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_campaign_model ON knowledge_fragments (campaign_id, embedding_model)`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_fragments_loc ON knowledge_fragments (campaign_id, embedding_model, macro_location)`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_session ON knowledge_fragments (session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_atlas_dirty ON location_atlas (campaign_id, rag_sync_needed)`,
    `CREATE INDEX IF NOT EXISTS idx_location_atlas_campaign ON location_atlas (campaign_id)`,
    `CREATE INDEX IF NOT EXISTS idx_location_history_campaign ON location_history (campaign_id)`,
    `CREATE INDEX IF NOT EXISTS idx_npc_dossier_campaign ON npc_dossier (campaign_id)`,
    `CREATE INDEX IF NOT EXISTS idx_npc_dossier_rag_sync ON npc_dossier (campaign_id, rag_sync_needed)`,
    `CREATE INDEX IF NOT EXISTS idx_npc_history_entity ON npc_history(campaign_id, entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_npc_history_name ON npc_history (campaign_id, npc_name)`,
    `CREATE INDEX IF NOT EXISTS idx_quest_history_entity ON quest_history(campaign_id, entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_quest_history_title ON quest_history (campaign_id, quest_title)`,
    `CREATE INDEX IF NOT EXISTS idx_quest_lifecycle_campaign_status ON quest_lifecycle_suggestions(campaign_id, status, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_quest_lifecycle_quest ON quest_lifecycle_suggestions(campaign_id, quest_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_quests_campaign ON quests (campaign_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_recordings_filename ON recordings (filename)`,
    `CREATE INDEX IF NOT EXISTS idx_recordings_session_id ON recordings (session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings (status)`,
    `CREATE INDEX IF NOT EXISTS idx_session_logs_session ON session_logs (session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_session_notes_session ON session_notes (session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_campaign ON sessions (campaign_id)`,
    `CREATE INDEX IF NOT EXISTS idx_usage_tracking_guild_month ON usage_tracking (guild_id, month)`,
    `CREATE INDEX IF NOT EXISTS idx_world_history_campaign ON world_history (campaign_id)`,
    `CREATE INDEX IF NOT EXISTS idx_world_history_year ON world_history (year)`,
];

/**
 * 4 validation triggers on `quests`.
 *
 * They stand in for CHECKs, which SQLite does not allow adding to an existing
 * table: without them an invalid quest state or type would enter the database
 * silently.
 */
const TRIGGERS: string[] = [
    `CREATE TRIGGER IF NOT EXISTS trg_quests_status_insert
        BEFORE INSERT ON quests
        WHEN NEW.status IS NULL OR NEW.status NOT IN ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'FAILED')
        BEGIN SELECT RAISE(ABORT, 'invalid quest status'); END`,
    `CREATE TRIGGER IF NOT EXISTS trg_quests_status_update
        BEFORE UPDATE OF status ON quests
        WHEN NEW.status IS NULL OR NEW.status NOT IN ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'FAILED')
        BEGIN SELECT RAISE(ABORT, 'invalid quest status'); END`,
    `CREATE TRIGGER IF NOT EXISTS trg_quests_type_insert
        BEFORE INSERT ON quests
        WHEN NEW.type IS NULL OR NEW.type NOT IN ('MAJOR', 'MINOR')
        BEGIN SELECT RAISE(ABORT, 'invalid quest type'); END`,
    `CREATE TRIGGER IF NOT EXISTS trg_quests_type_update
        BEFORE UPDATE OF type ON quests
        WHEN NEW.type IS NULL OR NEW.type NOT IN ('MAJOR', 'MINOR')
        BEGIN SELECT RAISE(ABORT, 'invalid quest type'); END`,
];

/**
 * Changes to already existing tables.
 *
 * Empty by construction: an idempotent `ALTER TABLE` goes here when a new
 * column has to reach already created databases too. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so "duplicate column name" must be ignored — it
 * is the signal that the upgrade had already been applied.
 */
const SCHEMA_UPGRADES: string[] = [
    // The campaign's embedding model. Fixed at the first indexing and it stays:
    // changing it makes the already computed vectors invisible, so it is an
    // explicit choice with a reindex, not a default that quietly drifts.
    `ALTER TABLE campaigns ADD COLUMN embedding_model TEXT`,
    `ALTER TABLE campaigns ADD COLUMN embedding_dimension INTEGER`,
    // Where that row's price came from. Without it, spend at an unknown rate
    // is indistinguishable from free: both are zero.
    `ALTER TABLE ai_usage_log ADD COLUMN pricing_source TEXT`,
    // Recording notice already given on this guild: it is shown once, not on
    // every session, or it becomes noise nobody reads.
    `ALTER TABLE tenants ADD COLUMN recording_notice_at INTEGER`,
    // Scope for the `$ask` history, so erasure can reach it. Existing rows stay
    // NULL: nothing knows which guild or user they belonged to, and inventing an
    // answer would be worse than admitting the gap. They are swept by the
    // channel-based fallback in dataErasure.ts instead.
    `ALTER TABLE chat_history ADD COLUMN guild_id TEXT`,
    `ALTER TABLE chat_history ADD COLUMN user_id TEXT`,
    // Image models are billed per picture, a third unit next to per-token and
    // per-minute. Reusing one of those columns would have made a $0.04 image
    // read as a $0.04-per-million-token model.
    `ALTER TABLE model_catalog ADD COLUMN per_image_usd REAL`,
    // Where an entity's picture came from, and the request that produced it.
    // `source` is the `is_manual` guard for media: something uploaded by hand is
    // never quietly replaced by a generated one. Two prompts on purpose —
    // `generation_prompt` is what reached the provider, `generation_user_prompt`
    // is what the person typed, and only the second one is worth showing back,
    // editing and running again.
    `ALTER TABLE entity_media ADD COLUMN source TEXT NOT NULL DEFAULT 'upload'`,
    `ALTER TABLE entity_media ADD COLUMN generation_mode TEXT`,
    `ALTER TABLE entity_media ADD COLUMN generation_prompt TEXT`,
    `ALTER TABLE entity_media ADD COLUMN generation_user_prompt TEXT`,
    `ALTER TABLE entity_media ADD COLUMN generation_request_json TEXT`,
    `ALTER TABLE entity_media ADD COLUMN reference_roles_json TEXT`,
    `ALTER TABLE entity_media ADD COLUMN reference_instruction TEXT`,
    `ALTER TABLE entity_media ADD COLUMN reference_auto_select INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE reference_image ADD COLUMN roles_json TEXT`,
    `ALTER TABLE reference_image ADD COLUMN instruction TEXT`,
    `ALTER TABLE reference_image ADD COLUMN auto_select INTEGER NOT NULL DEFAULT 1`,
    // How this table's pictures should look, in the table's own words. It is a
    // campaign-wide art direction rather than a per-image style, because the
    // point of it is that the gallery looks like one world; NULL keeps the
    // built-in painterly default.
    `ALTER TABLE campaigns ADD COLUMN art_direction TEXT`,
    // The picture on the campaign's card. It is presentation, not art direction:
    // a cover is chosen to be looked at by the table, while `reference_image` of
    // scope 'campaign' is fed to the image model — storing the cover there would
    // have made choosing a cover silently change every portrait generated after.
    // The major arcanum on the campaign's card. Drawn at creation and changed
    // from the campaign's settings; NULL on campaigns older than the column,
    // which fall back to a card derived from their id (see tarotArcana.ts).
    `ALTER TABLE campaigns ADD COLUMN tarot_arcana TEXT`,
    `ALTER TABLE campaigns ADD COLUMN cover_object_key TEXT`,
    `ALTER TABLE campaigns ADD COLUMN cover_thumbnail_key TEXT`,
    `ALTER TABLE campaigns ADD COLUMN cover_updated_at INTEGER`,
    // Per-field manual ownership in an appearance dossier. Without it the guard
    // is all-or-nothing: filling in one eye colour by hand would stop every
    // future analysis from adding anything at all.
    `ALTER TABLE entity_profile ADD COLUMN manual_fields TEXT`,

    /*
     * Backfill of the embedding model on already indexed campaigns.
     *
     * Without it, a campaign with fragments but an empty column would look
     * "not pinned yet": at the first new indexing the resolver would pick a
     * default model — possibly a different one — and pin it, making every
     * already computed vector invisible at a stroke. That would be exactly the
     * silent amnesia the per-campaign choice exists to prevent, caused by the
     * very migration that introduces it.
     *
     * The truth is in the fragments, which carry the model written on them:
     * we read it from there, we do not guess.
     */
    `UPDATE campaigns SET
        embedding_model = (
            SELECT k.embedding_model FROM knowledge_fragments k
            WHERE k.campaign_id = campaigns.id ORDER BY k.id DESC LIMIT 1
        ),
        embedding_dimension = (
            SELECT k.vector_dimension FROM knowledge_fragments k
            WHERE k.campaign_id = campaigns.id ORDER BY k.id DESC LIMIT 1
        )
     WHERE embedding_model IS NULL
       AND EXISTS (SELECT 1 FROM knowledge_fragments k WHERE k.campaign_id = campaigns.id)`,
];

function applySchemaUpgrades(): void {
    for (const statement of SCHEMA_UPGRADES) {
        try {
            db.exec(statement);
        } catch (error) {
            const message = (error as { message: string }).message;
            if (!message.includes('duplicate column name')) {
                console.error(`[DB] ⚠️ Schema upgrade fallito: "${statement}"`, error);
            }
        }
    }
}

/**
 * Lets an entity hold more than one picture.
 *
 * `entity_media` was created with `UNIQUE(campaign_id, entity_type, entity_key)`
 * — one picture each — and SQLite cannot drop a table constraint: the table has
 * to be rebuilt. This is the only migration in this project that rewrites a
 * table rather than adding a column, so it is written to be provably safe:
 *
 *  - it runs **only** when the old constraint is actually there, which makes it
 *    idempotent for free — after the rebuild the check no longer matches;
 *  - the column list is read from the existing table rather than assumed, so a
 *    database that missed an earlier `ALTER` cannot lose data to a hard-coded
 *    `SELECT`;
 *  - the whole swap is one transaction, with foreign keys off for the rename,
 *    which is the documented recipe.
 *
 * Every existing picture becomes its entity's primary one: that is what it was.
 */
function rebuildEntityMediaForGallery(): void {
    const table = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entity_media'",
    ).get() as { sql: string } | undefined;
    if (!table?.sql || !/UNIQUE\s*\(\s*campaign_id/i.test(table.sql)) return;

    const columns = (db.prepare('PRAGMA table_info(entity_media)').all() as Array<{ name: string }>)
        .map(column => column.name)
        .filter(name => name !== 'is_primary');
    const columnList = columns.map(name => `"${name}"`).join(', ');

    console.log('[DB] 🖼️ Rebuilding entity_media so an entity can hold several pictures…');
    db.pragma('foreign_keys = OFF');
    try {
        db.transaction(() => {
            db.exec(`CREATE TABLE entity_media__gallery (
                id TEXT PRIMARY KEY,
                campaign_id INTEGER NOT NULL,
                entity_type TEXT NOT NULL CHECK(entity_type IN ('npc', 'location', 'character', 'artifact')),
                entity_key TEXT NOT NULL,
                display_object_key TEXT NOT NULL,
                thumbnail_object_key TEXT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                size_bytes INTEGER NOT NULL,
                focal_x REAL NOT NULL DEFAULT 50 CHECK(focal_x >= 0 AND focal_x <= 100),
                focal_y REAL NOT NULL DEFAULT 50 CHECK(focal_y >= 0 AND focal_y <= 100),
                alt_text TEXT,
                source TEXT NOT NULL DEFAULT 'upload',
                generation_mode TEXT,
                generation_prompt TEXT,
                generation_user_prompt TEXT,
                generation_request_json TEXT,
                reference_roles_json TEXT,
                reference_instruction TEXT,
                reference_auto_select INTEGER NOT NULL DEFAULT 0,
                is_primary INTEGER NOT NULL DEFAULT 1,
                uploaded_by TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
            )`);
            db.exec(
                `INSERT INTO entity_media__gallery (${columnList}, is_primary) ` +
                `SELECT ${columnList}, 1 FROM entity_media`,
            );
            db.exec('DROP TABLE entity_media');
            db.exec('ALTER TABLE entity_media__gallery RENAME TO entity_media');
        })();
    } finally {
        db.pragma('foreign_keys = ON');
    }
    // The index went with the old table.
    db.exec('CREATE INDEX IF NOT EXISTS idx_entity_media_campaign ON entity_media(campaign_id, entity_type, entity_key)');
    console.log('[DB] 🖼️ entity_media rebuilt: every existing picture kept, and marked as its entity\'s main one.');
}

/** Adds the `reference` failure kind to databases created before this feature. */
function rebuildAiJobForReferenceFailures(): void {
    const table = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_job'",
    ).get() as { sql: string } | undefined;
    if (!table?.sql || table.sql.includes("'reference'")) return;

    console.log('[DB] 🖼️ Rebuilding ai_job to record reference failures…');
    db.pragma('foreign_keys = OFF');
    try {
        db.transaction(() => {
            db.exec(`CREATE TABLE ai_job__reference_error (
                id TEXT PRIMARY KEY,
                campaign_id INTEGER NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('image', 'appearance', 'quest-audit', 'character-bio')),
                target_type TEXT NOT NULL CHECK(target_type IN ('npc', 'location', 'character', 'artifact', 'campaign')),
                target_key TEXT NOT NULL,
                target_label TEXT,
                requested_by TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN (
                    'queued', 'running', 'awaiting_review', 'succeeded', 'discarded', 'failed', 'expired')),
                params_json TEXT NOT NULL,
                result_json TEXT,
                result_original_key TEXT,
                result_display_key TEXT,
                error_kind TEXT CHECK(error_kind IS NULL OR error_kind IN (
                    'refused', 'reference', 'not_configured', 'provider', 'storage', 'interrupted', 'internal')),
                error_message TEXT,
                provider TEXT,
                model TEXT,
                pricing_available INTEGER,
                usage_run_id TEXT,
                seen_at INTEGER,
                created_at INTEGER NOT NULL,
                started_at INTEGER,
                finished_at INTEGER,
                expires_at INTEGER,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
            )`);
            db.exec(`INSERT INTO ai_job__reference_error SELECT * FROM ai_job`);
            db.exec('DROP TABLE ai_job');
            db.exec('ALTER TABLE ai_job__reference_error RENAME TO ai_job');
        })();
    } finally {
        db.pragma('foreign_keys = ON');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_ai_job_campaign ON ai_job (campaign_id, created_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ai_job_requester ON ai_job (requested_by, created_at DESC)');
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_job_active
        ON ai_job (campaign_id, kind, target_type, target_key)
        WHERE status IN ('queued', 'running')`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_ai_job_claimable ON ai_job (created_at) WHERE status = 'queued'");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ai_job_expiry ON ai_job (expires_at) WHERE status = 'awaiting_review'");
}

export const initDatabase = () => {
    // Mandatory order: tables before the indexes and triggers that reference them.
    for (const statement of [...TABLES, ...INDEXES, ...TRIGGERS]) {
        db.exec(statement);
    }
    applySchemaUpgrades();
    rebuildAiJobForReferenceFailures();
    // After the column upgrades: the rebuild copies whatever columns it finds.
    rebuildEntityMediaForGallery();
};
