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
 * Formato: "type:id" es. "npc:1", "pc:15", "quest:42", "loc:7"
 */
export type EntityType = 'npc' | 'pc' | 'quest' | 'loc' | 'item' | 'monster' | 'generic';

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
}
