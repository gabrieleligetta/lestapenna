export interface UserProfile {
    character_name: string | null;
    race: string | null;
    class: string | null;
    description: string | null;
    email?: string | null; // 🆕 Email for the session recap
    rag_sync_needed?: number; // NUOVO
    alignment_moral?: string | null; // 🆕
    alignment_ethical?: string | null; // 🆕
    moral_score?: number; // 🆕
    ethical_score?: number; // 🆕
    manual_description?: string | null; // 🆕 Manual Backup
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
    short_id?: string; // 🆕 Stable ID
    alignment_moral?: string | null; // 🆕
    alignment_ethical?: string | null; // 🆕
    moral_score?: number; // 🆕
    ethical_score?: number; // 🆕
    manual_description?: string | null; // 🆕 Manual Backup
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

// Compatible with transcriptUtils.ts
export interface TranscriptEntry {
    transcription_text: string | null;
    timestamp: number;
    character_name: string | null; // Mandatory key, nullable value
    macro_location?: string | null;
    micro_location?: string | null;
    user_id?: string;
    character_name_snapshot?: string | null; // Extra field
}

export interface SessionSummary {
    session_id: string;
    start_time: number;
    fragments: number;
    campaign_name?: string;
    campaign_id?: number; // Added for filtering
    session_number?: number | null;
    title?: string | null;
}

export interface SessionNavigationItem {
    session_id: string;
    start_time: number;
    session_number: number | null;
    title: string | null;
}

export interface SessionNavigation {
    previous: SessionNavigationItem | null;
    next: SessionNavigationItem | null;
}

export interface SessionParticipant {
    user_id: string;
    character_name: string | null;
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
    party_alignment_moral?: 'GOOD' | 'NEUTRAL' | 'EVIL';
    party_alignment_ethical?: 'LAWFUL' | 'NEUTRAL' | 'CHAOTIC';
    party_moral_score?: number; // 🆕
    party_ethical_score?: number; // 🆕
    /** 🆕 Language spoken at the table (transcription + AI output). Null = the guild's language. */
    language?: string | null;
    /**
     * How this table's generated pictures should look, in its own words.
     *
     * Campaign-wide rather than per image, because the point of it is that the
     * gallery looks like one world. Null keeps the built-in painterly default.
     */
    art_direction?: string | null;
    /**
     * The major arcanum this campaign's card is drawn as.
     *
     * NULL on campaigns older than the column: they fall back to a card derived
     * from their id, so the shelf does not reshuffle itself between two loads
     * (`services/tarotArcana.ts`).
     */
    tarot_arcana?: string | null;
    /**
     * The picture shown on the campaign's card, in two variants.
     *
     * Deliberately not a `reference_image` of scope 'campaign': those are handed
     * to the image model, so a cover stored there would change what every later
     * portrait looks like. A cover is chosen to be looked at, nothing else.
     */
    cover_object_key?: string | null;
    cover_thumbnail_key?: string | null;
    cover_updated_at?: number | null;
}

export interface KnowledgeFragment {
    id: number;
    campaign_id: number;
    session_id: string;
    content: string;
    embedding_json: string;
    /** Vettore Float32 raw (fonte primaria in lettura; embedding_json = fallback/rollback). */
    embedding?: Buffer | null;
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
    note_text?: string;
    author_name?: string;
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
    short_id?: string; // 🆕 Stable ID
    alignment_moral?: string | null; // 🆕
    alignment_ethical?: string | null; // 🆕
    manual_description?: string | null; // 🆕 Manual Backup
}

export enum QuestStatus {
    OPEN = 'OPEN',
    IN_PROGRESS = 'IN_PROGRESS',
    COMPLETED = 'COMPLETED',
    FAILED = 'FAILED'
}

export const QUEST_STATUSES = Object.values(QuestStatus);
export const QUEST_TYPES = ['MAJOR', 'MINOR'] as const;
export type QuestType = typeof QUEST_TYPES[number];

export function normalizeQuestStatus(value: unknown): QuestStatus | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toUpperCase();
    const aliases: Record<string, QuestStatus> = {
        OPEN: QuestStatus.OPEN,
        APERTA: QuestStatus.OPEN,
        TODO: QuestStatus.OPEN,
        'DA INIZIARE': QuestStatus.OPEN,
        IN_PROGRESS: QuestStatus.IN_PROGRESS,
        'IN PROGRESS': QuestStatus.IN_PROGRESS,
        'IN CORSO': QuestStatus.IN_PROGRESS,
        PROGRESS: QuestStatus.IN_PROGRESS,
        ONGOING: QuestStatus.IN_PROGRESS,
        COMPLETED: QuestStatus.COMPLETED,
        COMPLETATA: QuestStatus.COMPLETED,
        DONE: QuestStatus.COMPLETED,
        SUCCEEDED: QuestStatus.COMPLETED,
        FINISH: QuestStatus.COMPLETED,
        FINISHED: QuestStatus.COMPLETED,
        FAILED: QuestStatus.FAILED,
        FALLITA: QuestStatus.FAILED,
        FAIL: QuestStatus.FAILED
    };
    return aliases[normalized] ?? null;
}

export function normalizeQuestType(value: unknown): QuestType | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toUpperCase();
    return QUEST_TYPES.includes(normalized as QuestType) ? normalized as QuestType : null;
}

export interface Quest {
    id: number;
    campaign_id: number;
    title: string;
    description?: string;
    status: QuestStatus;
    type?: QuestType;
    created_at: number;
    last_updated: number;
    session_id?: string;
    short_id?: string; // 🆕 Stable ID
    manual_description?: string | null; // 🆕 Manual Backup
}

export const QUEST_LIFECYCLE_ACTIONS = ['CREATE', 'STATUS_CHANGE'] as const;
export type QuestLifecycleAction = typeof QUEST_LIFECYCLE_ACTIONS[number];
export const QUEST_LIFECYCLE_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type QuestLifecycleConfidence = typeof QUEST_LIFECYCLE_CONFIDENCES[number];
export const QUEST_LIFECYCLE_SUGGESTION_STATUSES = ['PENDING', 'APPLIED', 'DISMISSED'] as const;
export type QuestLifecycleSuggestionStatus = typeof QUEST_LIFECYCLE_SUGGESTION_STATUSES[number];

export interface QuestLifecycleSuggestion {
    id: number;
    campaign_id: number;
    quest_id: number | null;
    session_id: string | null;
    proposed_action: QuestLifecycleAction;
    proposed_title: string;
    proposed_description: string | null;
    proposed_status: QuestStatus;
    proposed_type: QuestType;
    evidence: string;
    confidence: QuestLifecycleConfidence;
    status: QuestLifecycleSuggestionStatus;
    created_at: number;
    resolved_at: number | null;
}

export const INVENTORY_CATEGORIES = [
    'WEAPON',
    'ARMOR',
    'CONSUMABLE',
    'TOOL',
    'MATERIAL',
    'TREASURE',
    'QUEST_ITEM',
    'OTHER',
] as const;

export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number];

export interface InventoryItem {
    id: number;
    campaign_id: number;
    item_name: string;
    quantity: number;
    category: InventoryCategory;
    acquired_at: number;
    last_updated: number;
    session_id?: string;
    description?: string;
    notes?: string;
    short_id?: string; // 🆕 Stable ID
    manual_description?: string | null; // 🆕 Manual Backup
}

export interface PendingMerge {
    message_id: string;
    campaign_id: number;
    detected_name: string;
    target_name: string;
    new_description: string;
    role: string;
}

// Spell out exactly what the snapshot holds
export interface CampaignSnapshot {
    characters: any[];
    quests: any[];
    location: { macro: string | null; micro: string | null } | null;
    macro: string | null;
    micro: string | null;
    atlasDesc: string | null;
    // These stay for compatibility, or for quick use in the prompt
    pc_context: string;
    quest_context: string;
    location_context: string;
}

export interface BestiaryEntry {
    id: number;
    campaign_id: number;
    name: string;
    status: string;
    session_id: string | null;
    last_seen: number | null;
    description: string | null;
    abilities: string | null;
    weaknesses: string | null;
    resistances: string | null;
    notes: string | null;
    variants: string | null; // JSON-encoded TEXT, like abilities/weaknesses/resistances
    first_session_id: string | null;
    short_id?: string; // 🆕 Stable ID
    manual_description?: string | null; // 🆕 Manual Backup
}

export interface MonsterDetails {
    description?: string;
    abilities?: string[];
    weaknesses?: string[];
    resistances?: string[];
    notes?: string;
}

/**
 * Entity Reference Types - typed prefixes to disambiguate entities in the RAG
 * Format: "type:id", e.g. "npc:1", "pc:15", "quest:42", "loc:7", "faction:3"
 */
export type EntityType = 'npc' | 'pc' | 'quest' | 'loc' | 'item' | 'monster' | 'faction' | 'generic';

export interface EntityRef {
    type: EntityType;
    id: number;
}

/**
 * Returns every location that needs a RAG sync
 */
export interface AtlasEntryFull {
    id: number;
    campaign_id: number;
    macro_location: string;
    micro_location: string;
    description: string | null;
    last_updated: string;
    rag_sync_needed?: number;
    short_id?: string; // 🆕 Stable ID
    manual_description?: string | null; // 🆕 Manual Backup
}

// =============================================
// 🆕 FACTION SYSTEM TYPES
// =============================================

/**
 * Reputation levels of the party with a faction (7-level spectrum)
 */
export type ReputationLevel =
    | 'HOSTILE'      // -3: Nemici dichiarati
    | 'DISTRUSTFUL'  // -2: Sospettosi, poco cooperativi
    | 'COLD'         // -1: Distaccati, formali
    | 'NEUTRAL'      //  0: Default, no opinion
    | 'CORDIAL'      // +1: Amichevoli, disponibili
    | 'FRIENDLY'     // +2: allies in practice
    | 'ALLIED';      // +3: Alleanza formale

export const REPUTATION_SPECTRUM: ReputationLevel[] = [
    'HOSTILE', 'DISTRUSTFUL', 'COLD', 'NEUTRAL', 'CORDIAL', 'FRIENDLY', 'ALLIED'
];

export type FactionType = 'PARTY' | 'GUILD' | 'KINGDOM' | 'CULT' | 'ORGANIZATION' | 'GENERIC';
export type FactionStatus = 'ACTIVE' | 'DISBANDED' | 'DESTROYED';
export type AffiliationRole = 'LEADER' | 'MEMBER' | 'ALLY' | 'ENEMY' | 'CONTROLLED' | 'HQ' | 'PRESENCE' | 'HOSTILE' | 'PRISONER';
export type AffiliationEntityType = 'npc' | 'location' | 'pc';

export interface FactionEntry {
    id: number;
    campaign_id: number;
    name: string;
    description: string | null;
    type: FactionType;
    leader_npc_id: number | null;
    headquarters_location_id: number | null;
    status: FactionStatus;
    is_party: number;
    first_session_id: string | null;
    last_updated: string;
    rag_sync_needed: number;
    is_manual: number;
    short_id?: string;
    alignment_moral?: string | null;   // 🆕 GOOD, NEUTRAL, EVIL
    alignment_ethical?: string | null; // 🆕 LAWFUL, NEUTRAL, CHAOTIC
    moral_score?: number; // 🆕
    ethical_score?: number; // 🆕
    /** The column has always been there; the type had simply never declared it. */
    manual_description?: string | null;
}

export interface FactionReputation {
    id: number;
    campaign_id: number;
    faction_id: number;
    reputation: ReputationLevel;
    reputation_score: number; // 🆕
    last_updated: string;
    // Joined fields (optional, for queries with JOIN)
    faction_name?: string;
}

export interface FactionAffiliation {
    id: number;
    faction_id: number;
    entity_type: AffiliationEntityType;
    entity_id: number;
    role: AffiliationRole;
    joined_session_id: string | null;
    is_active: number;
    notes: string | null;
    // Joined fields (optional, for queries with JOIN)
    faction_name?: string;
    entity_name?: string;
}

export interface FactionHistoryEntry {
    id: number;
    campaign_id: number;
    faction_name: string;
    session_id: string | null;
    event_type: 'REPUTATION_CHANGE' | 'MEMBER_JOIN' | 'MEMBER_LEAVE' | 'CONFLICT' | 'ALLIANCE' | 'DISSOLUTION' | 'GENERIC';
    description: string;
    timestamp: number;
    is_manual: number;
    reputation_change_value?: number; // 🆕
    moral_weight?: number; // 🆕
    ethical_weight?: number; // 🆕
}

export interface LocationHistoryEntry {
    id: number;
    campaign_id: number;
    location: string;
    session_id?: string;
    description?: string;
    timestamp: number;
    is_manual?: number;
    reason?: string;
}

export interface WorldHistoryEntry {
    id: number;
    campaign_id: number;
    session_id?: string;
    event_type: 'WAR' | 'POLITICS' | 'DISCOVERY' | 'CALAMITY' | 'SUPERNATURAL' | 'GENERIC';
    description: string;
    timestamp: number;
    year?: number;
    is_manual?: number;
    short_id?: string; // 🆕 Stable ID (permalink for a single world event)
    moral_weight?: number; // 🆕
    ethical_weight?: number; // 🆕
}

// =============================================
// 🆕 ARTIFACT SYSTEM TYPES
// =============================================

/**
 * Stati possibili di un artefatto
 */
export type ArtifactStatus = 'FUNCTIONAL' | 'DESTROYED' | 'LOST' | 'SEALED' | 'DORMANT';

/**
 * Tipi di proprietario per un artefatto
 */
export type ArtifactOwnerType = 'PC' | 'NPC' | 'FACTION' | 'LOCATION' | 'NONE';

export interface QuestHistoryEntry {
    id: number;
    campaign_id: number;
    quest_name: string;
    session_id?: string;
    event_type: 'STARTED' | 'UPDATED' | 'COMPLETED' | 'FAILED' | 'ABANDONED';
    description: string;
    timestamp: number;
    moral_weight?: number; // 🆕
    ethical_weight?: number; // 🆕
}

export interface CharacterHistoryEntry {
    id: number;
    campaign_id: number;
    character_name: string;
    session_id?: string;
    event_type: 'BACKGROUND' | 'TRAUMA' | 'RELATIONSHIP' | 'ACHIEVEMENT' | 'GOAL_CHANGE';
    description: string;
    timestamp: number;
    is_manual?: number;
    moral_weight?: number; // 🆕
    ethical_weight?: number; // 🆕
    faction_id?: number; // 🆕 Added
}

export interface NpcHistoryEntry {
    id: number;
    campaign_id: number;
    npc_name: string;
    session_id?: string;
    event_type: 'REVELATION' | 'BETRAYAL' | 'DEATH' | 'ALLIANCE' | 'STATUS_CHANGE';
    description: string;
    timestamp: number;
    is_manual?: number;
    moral_weight?: number; // 🆕
    ethical_weight?: number; // 🆕
    faction_id?: number; // 🆕 Added
}

export interface ArtifactEntry {
    id: number;
    campaign_id: number;
    name: string;
    description: string | null;
    effects: string | null;
    is_cursed: number;
    curse_description: string | null;
    owner_type: ArtifactOwnerType | null;
    owner_id: number | null;
    owner_name: string | null;
    location_macro: string | null;
    location_micro: string | null;
    faction_id: number | null;
    status: ArtifactStatus;
    first_session_id: string | null;
    last_updated: string;
    rag_sync_needed: number;
    is_manual: number;
    short_id?: string;
    manual_description?: string | null; // 🆕 Manual Backup
}

export interface ArtifactHistoryEntry {
    id: number;
    campaign_id: number;
    artifact_name: string;
    session_id: string | null;
    event_type: 'DISCOVERY' | 'ACTIVATION' | 'CURSE_REVEAL' | 'DESTRUCTION' | 'TRANSFER' | 'OBSERVATION' | 'MANUAL_UPDATE';
    description: string;
    timestamp: number;
    is_manual: number;
}

export const ENTITY_MEDIA_TYPES = ['npc', 'location', 'character', 'artifact'] as const;
export type EntityMediaType = typeof ENTITY_MEDIA_TYPES[number];

export interface EntityMediaEntry {
    id: string;
    campaign_id: number;
    entity_type: EntityMediaType;
    entity_key: string;
    display_object_key: string;
    thumbnail_object_key: string;
    width: number;
    height: number;
    size_bytes: number;
    focal_x: number;
    focal_y: number;
    alt_text: string | null;
    /** Where the picture came from. `'ai'` is what the regeneration guard reads. */
    source: EntityMediaSource;
    generation_mode: ImageGenerationMode | null;
    /** The prompt that actually reached the provider. */
    generation_prompt: string | null;
    /** The words the person typed — the only ones worth showing back and editing. */
    generation_user_prompt: string | null;
    /** Complete provider-neutral request, for an auditable and repeatable generation. */
    generation_request_json: string | null;
    /** JSON array of the roles this picture contributes when used as a reference. */
    reference_roles_json: string | null;
    reference_instruction: string | null;
    /** Whether this picture is normally preselected; the primary picture is always pertinent. */
    reference_auto_select: number;
    /** 1 on the one picture the sheet shows; the rest are the gallery. */
    is_primary: number;
    uploaded_by: string;
    created_at: number;
    updated_at: number;
}

export const ENTITY_MEDIA_SOURCES = ['upload', 'ai'] as const;
export type EntityMediaSource = typeof ENTITY_MEDIA_SOURCES[number];

/**
 * How a generated portrait was asked for.
 *
 * `auto` builds the prompt from the campaign's own material, `prompt` uses only
 * what the person wrote, `mixed` uses both with the person's words binding.
 */
export const IMAGE_GENERATION_MODES = ['auto', 'prompt', 'mixed'] as const;
export type ImageGenerationMode = typeof IMAGE_GENERATION_MODES[number];

// =============================================
// APPEARANCE DOSSIER
// =============================================

/**
 * Where a trait was found.
 *
 * Kept per trait rather than per dossier because that is the granularity at
 * which someone disagrees: «the armour is right, the hair is not» is a useful
 * sentence only if each of the two can be traced separately.
 */
export const TRAIT_SOURCES = ['sheet', 'history', 'faction', 'transcript', 'rag'] as const;
export type TraitSource = typeof TRAIT_SOURCES[number];

export interface TraitEvidence {
    /** Dotted path into the appearance object, e.g. `hair.colour`. */
    trait: string;
    /** What the material actually says. Verbatim where it can be. */
    quote: string;
    source: TraitSource;
    session_id?: string | null;
}

export const TRAIT_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type TraitConfidence = typeof TRAIT_CONFIDENCES[number];

/**
 * A person, as an artist would need them described.
 *
 * Every field is optional and that is the whole point: a missing field means
 * the campaign never said, and the prompt simply says nothing about it. The
 * alternative — a paragraph that must be written whatever the material holds —
 * is what produced a tiefling with ram horns for an NPC whose records contain
 * no physical detail at all.
 */
export interface PersonAppearance {
    age_band?: string;
    build?: string;
    height?: string;
    skin?: string;
    hair?: { colour?: string; length?: string; style?: string };
    eyes?: string;
    face_marks?: string[];
    garments?: string[];
    armour?: { type?: string; material?: string; finish?: string };
    /** Livery, heraldry, a badge of office — usually inherited from a faction. */
    insignia?: string;
    weapons?: string[];
    bearing?: string;
}

export interface PlaceAppearance {
    setting?: string;
    architecture?: string;
    materials?: string;
    scale?: string;
    /** Ruined, half-built, spotless: the state it is actually in. */
    state?: string;
    light?: string;
    weather?: string;
    notable_features?: string[];
}

export interface ObjectAppearance {
    form?: string;
    material?: string;
    size?: string;
    ornament?: string;
    wear?: string;
    glow?: string;
}

export type EntityAppearance = PersonAppearance | PlaceAppearance | ObjectAppearance;

/** How someone comes across. People only; a door has no temperament. */
export interface EntityPersonality {
    temperament?: string;
    manner?: string;
    voice?: string;
}

export interface EntityProfileEntry {
    id: string;
    campaign_id: number;
    entity_type: EntityMediaType;
    /** The public short id, as it appears in the URL. */
    entity_key: string;
    appearance_json: string | null;
    appearance_text: string | null;
    personality_text: string | null;
    evidence_json: string | null;
    confidence: TraitConfidence | null;
    /** True when any field was written by hand. */
    is_manual: number;
    /** JSON array of the field paths a person owns. The AI never overwrites these. */
    manual_fields: string | null;
    provider: string | null;
    model: string | null;
    generated_at: number | null;
    /** Set when a session later than the analysis mentions the entity. */
    stale_since_session_id: string | null;
    created_at: number;
    updated_at: number;
}

/**
 * What a reference picture is a reference *for*.
 *
 * `campaign` is the art direction of the whole gallery, `faction` the livery a
 * member wears, `entity` the portrait already accepted for this subject — the
 * last one is what keeps a face the same across regenerations.
 */
export const REFERENCE_SCOPES = ['campaign', 'faction', 'entity'] as const;
export type ReferenceScope = typeof REFERENCE_SCOPES[number];

export interface ReferenceImageEntry {
    id: string;
    campaign_id: number;
    scope: ReferenceScope;
    /** Empty for `campaign`; the faction short id, or `<type>:<short id>`. */
    scope_key: string;
    object_key: string;
    mime_type: string;
    width: number;
    height: number;
    size_bytes: number;
    label: string | null;
    /** JSON array of provider-neutral visual roles. */
    roles_json: string | null;
    instruction: string | null;
    auto_select: number;
    uploaded_by: string;
    created_at: number;
}

/** A durable one-job reference. Its bytes survive the HTTP process and a restart. */
export interface ScratchReferenceEntry {
    id: string;
    campaign_id: number;
    object_key: string;
    mime_type: string;
    width: number;
    height: number;
    size_bytes: number;
    label: string | null;
    roles_json: string | null;
    instruction: string | null;
    uploaded_by: string;
    job_id: string | null;
    expires_at: number;
    created_at: number;
}

// =============================================
// GILDE E TELEMETRIA D'USO
// =============================================

export interface Tenant {
    guild_id: string;
    created_at: number;
    admin_discord_id: string | null;
}

export interface UsageTracking {
    id: number;
    guild_id: string;
    month: string; // '2026-03'
    sessions_used: number;
    audio_minutes_used: number;
    ai_cost_usd: number;
    /** NULL means the total contains legacy/unconverted USD costs. */
    ai_cost_eur: number | null;
    storage_bytes: number;
}

export interface AiUsageLogEntry {
    id: number;
    session_id: string;
    guild_id: string | null;
    campaign_id: number | null;
    phase: string;
    provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    input_price_per_million: number | null;
    output_price_per_million: number | null;
    cached_input_price_per_million: number | null;
    cost_usd: number;
    cost_eur: number | null;
    /** ECB quote: USD for one EUR. */
    usd_per_eur: number | null;
    exchange_rate_source: 'ECB' | 'STALE_ECB' | 'UNAVAILABLE' | null;
    exchange_rate_date: string | null;
    exchange_rate_fetched_at: number | null;
    created_at: number;
}
