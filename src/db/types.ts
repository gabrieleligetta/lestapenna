export interface UserProfile {
    character_name: string | null;
    race: string | null;
    class: string | null;
    description: string | null;
    email?: string | null; // 🆕 Email per recap sessione
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

// Compatibile con transcriptUtils.ts
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
    party_alignment_moral?: 'BUONO' | 'NEUTRALE' | 'CATTIVO';
    party_alignment_ethical?: 'LEGALE' | 'NEUTRALE' | 'CAOTICO';
    party_moral_score?: number; // 🆕
    party_ethical_score?: number; // 🆕
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

export interface Quest {
    id: number;
    campaign_id: number;
    title: string;
    description?: string;
    status: QuestStatus;
    type?: 'MAJOR' | 'MINOR';
    created_at: number;
    last_updated: number;
    session_id?: string;
    short_id?: string; // 🆕 Stable ID
    manual_description?: string | null; // 🆕 Manual Backup
}

export interface InventoryItem {
    id: number;
    campaign_id: number;
    item_name: string;
    quantity: number;
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

// Definiamo bene cosa contiene lo snapshot
export interface CampaignSnapshot {
    characters: any[];
    quests: any[];
    location: { macro: string | null; micro: string | null } | null;
    macro: string | null;
    micro: string | null;
    atlasDesc: string | null;
    // Queste restano per compatibilità o per uso rapido nel prompt
    pc_context: string;
    quest_context: string;
    location_context: string;
}

export interface BestiaryEntry {
    id: number;
    campaign_id: number;
    name: string;
    status: string;
    count: string | null;
    session_id: string | null;
    last_seen: number | null;
    description: string | null;
    abilities: string | null;
    weaknesses: string | null;
    resistances: string | null;
    notes: string | null;
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
 * Entity Reference Types - Prefissi tipizzati per disambiguare entità nel RAG
 * Formato: "type:id" es. "npc:1", "pc:15", "quest:42", "loc:7", "faction:3"
 */
export type EntityType = 'npc' | 'pc' | 'quest' | 'loc' | 'item' | 'monster' | 'faction' | 'generic';

export interface EntityRef {
    type: EntityType;
    id: number;
}

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
    short_id?: string; // 🆕 Stable ID
    manual_description?: string | null; // 🆕 Manual Backup
}

// =============================================
// 🆕 FACTION SYSTEM TYPES
// =============================================

/**
 * Livelli di reputazione del party con una fazione (spettro a 7 livelli)
 */
export type ReputationLevel =
    | 'OSTILE'      // -3: Nemici dichiarati
    | 'DIFFIDENTE'  // -2: Sospettosi, poco cooperativi
    | 'FREDDO'      // -1: Distaccati, formali
    | 'NEUTRALE'    //  0: Default, nessuna opinione
    | 'CORDIALE'    // +1: Amichevoli, disponibili
    | 'AMICHEVOLE'  // +2: Alleati di fatto
    | 'ALLEATO';    // +3: Alleanza formale

export const REPUTATION_SPECTRUM: ReputationLevel[] = [
    'OSTILE', 'DIFFIDENTE', 'FREDDO', 'NEUTRALE', 'CORDIALE', 'AMICHEVOLE', 'ALLEATO'
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
    alignment_moral?: string | null;   // 🆕 BUONO, NEUTRALE, CATTIVO
    alignment_ethical?: string | null; // 🆕 LEGALE, NEUTRALE, CAOTICO
    moral_score?: number; // 🆕
    ethical_score?: number; // 🆕
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
    moral_weight?: number; // 🆕
    ethical_weight?: number; // 🆕
}

// =============================================
// 🆕 ARTIFACT SYSTEM TYPES
// =============================================

/**
 * Stati possibili di un artefatto
 */
export type ArtifactStatus = 'FUNZIONANTE' | 'DISTRUTTO' | 'PERDUTO' | 'SIGILLATO' | 'DORMIENTE';

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
