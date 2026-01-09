export interface Campaign {
    id: number;
    guild_id: string;
    name: string;
    is_active: number;
    created_at: number;
    current_year: number;
    current_location?: string | null;
    current_macro_location?: string | null;
    current_micro_location?: string | null;
}

export interface Character {
    user_id: string;
    campaign_id: number;
    character_name: string;
    race: string | null;
    class: string | null;
    description: string | null;
}

export interface CharacterHistory {
    id: number;
    campaign_id: number;
    character_name: string;
    session_id: string | null;
    event_type: string | null;
    description: string;
    timestamp: number | null;
}

export interface NpcHistory {
    id: number;
    campaign_id: number;
    npc_name: string;
    session_id: string | null;
    event_type: string | null;
    description: string;
    timestamp: number | null;
}

export interface WorldHistory {
    id: number;
    campaign_id: number;
    session_id: string | null;
    event_type: string | null;
    description: string;
    timestamp: number | null;
    year: number | null;
}

export interface Session {
    session_id: string;
    guild_id: string | null;
    campaign_id: number | null;
    session_number: number | null;
    title: string | null;
    summary: string | null;
    start_time: number | null;
    end_time: number | null;
}

export interface Recording {
    id: number;
    session_id: string | null;
    filename: string;
    filepath: string;
    user_id: string | null;
    timestamp: number | null;
    status: string; // 'PENDING', 'PROCESSING', 'SECURED', 'ERROR'
    transcription_text: string | null;
    error_log: string | null;
    macro_location: string | null;
    micro_location: string | null;
    year: number | null;
    present_npcs: string | null;
    character_name_snapshot: string | null;
}

export interface SessionNote {
    id: number;
    session_id: string;
    user_id: string | null;
    content: string;
    timestamp: number | null;
    created_at: number | null;
    macro_location: string | null;
    micro_location: string | null;
}

export interface KnowledgeFragment {
    id: number;
    campaign_id: number;
    session_id: string | null;
    content: string;
    embedding_json: string | null;
    embedding_model: string | null;
    vector_dimension: number | null;
    start_timestamp: number | null;
    created_at: number | null;
    macro_location: string | null;
    micro_location: string | null;
    associated_npcs: string | null;
}

export interface ChatHistory {
    id: number;
    channel_id: string;
    role: string;
    content: string;
    timestamp: number | null;
}

export interface LocationHistory {
    id: number;
    campaign_id: number;
    location: string | null;
    macro_location: string | null;
    micro_location: string | null;
    session_date: string | null;
    timestamp: number | null;
    session_id: string | null;
}

export interface LocationAtlas {
    id: number;
    campaign_id: number;
    macro_location: string;
    micro_location: string;
    description: string | null;
    last_updated: string | null; // DATETIME DEFAULT CURRENT_TIMESTAMP usually returns string
}

export interface NpcDossier {
    id: number;
    campaign_id: number;
    name: string;
    role: string | null;
    description: string | null;
    status: string | null; // DEFAULT 'ALIVE'
    last_seen_location: string | null;
    last_updated: string | null; // DATETIME DEFAULT CURRENT_TIMESTAMP
}

export interface Quest {
    id: number;
    campaign_id: number;
    title: string;
    status: string | null; // DEFAULT 'OPEN'
    created_at: number | null;
    last_updated: number | null;
}

export interface InventoryItem {
    id: number;
    campaign_id: number;
    item_name: string;
    quantity: number | null; // DEFAULT 1
    acquired_at: number | null;
    last_updated: number | null;
}

export interface Config {
    key: string;
    value: string | null;
}
