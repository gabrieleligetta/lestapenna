/**
 * Bard Types - All interfaces and type definitions
 */

// --- TONES ---
export const TONES = {
    EPICO: "Sei un cantastorie epico. Usa un linguaggio epico, solenne, enfatizza l'eroismo e il destino.",
    DIVERTENTE: "Sei un bardo ubriaco e sarcastico. Prendi in giro i fallimenti dei personaggi.",
    OSCURO: "Sei un cronista di un mondo Lovecraftiano. Tono cupo e disperato.",
    CONCISO: "Sei un segretario efficiente. solo fatti narrazione in terza persona.",
    DM: "Sei un assistente per il Dungeon Master. Punti salienti, loot e NPC."
};

export type ToneKey = keyof typeof TONES;

// --- AI RESPONSE ---
export interface AIResponse {
    segments: any[];
    detected_location?: {
        macro?: string;
        micro?: string;
        confidence: string;
    };
    atlas_update?: string;
    npc_updates?: Array<{
        name: string;
        description: string;
        role?: string;
        status?: string;
    }>;
    monsters?: Array<{
        name: string;
        status: "DEFEATED" | "ALIVE" | "FLED";
        count?: string;
    }>;
    present_npcs?: string[];
}

// --- SUMMARY RESPONSE ---
export interface SummaryResponse {
    summary: string;
    title: string;
    tokens: number;
    loot?: Array<{ name: string; quantity?: number; description?: string }>;
    loot_removed?: Array<{ name: string; quantity?: number; description?: string }>;
    quests?: Array<{ title: string; description?: string; status?: string }>;
    narrative?: string;
    narrativeBrief?: string;
    narrativeBriefs?: string[]; // Array di brief per ogni atto (per Discord multi-messaggio)
    log?: string[];
    character_growth?: Array<{
        name: string;
        event: string;
        type: 'BACKGROUND' | 'TRAUMA' | 'RELATIONSHIP' | 'ACHIEVEMENT' | 'GOAL_CHANGE';
    }>;
    npc_events?: Array<{
        name: string;
        event: string;
        type: 'REVELATION' | 'BETRAYAL' | 'DEATH' | 'ALLIANCE' | 'STATUS_CHANGE' | 'GENERIC';
    }>;
    world_events?: Array<{
        event: string;
        type: 'WAR' | 'POLITICS' | 'DISCOVERY' | 'CALAMITY' | 'SUPERNATURAL' | 'GENERIC';
    }>;
    monsters?: Array<{
        name: string;
        status: string;
        count?: string;
        description?: string;
        abilities?: string[];
        weaknesses?: string[];
        resistances?: string[];
    }>;
    npc_dossier_updates?: Array<{
        name: string;
        description: string;
        role?: string;
        status?: 'ALIVE' | 'DEAD' | 'MISSING';
    }>;
    location_updates?: Array<{
        macro: string;
        micro: string;
        description: string;
    }>;
    travel_sequence?: Array<{
        macro: string;
        micro: string;
        reason?: string;
    }>;
    present_npcs?: string[];
    session_data?: {
        travels: Array<{
            timestamp: number;
            macro_location: string | null;
            micro_location: string | null;
        }>;
        encountered_npcs: Array<{
            name: string;
            role: string | null;
            status: string;
            description: string | null;
        }>;
        campaign_info: {
            name: string;
            session_number: string | number;
            session_date: string;
        };
    };
    // 🆕 Faction System
    faction_updates?: Array<{
        name: string;
        description?: string;
        type?: string;
        reputation_change?: {
            direction: 'UP' | 'DOWN';
            reason: string;
        };
    }>;
    faction_affiliations?: Array<{
        entity_type: 'npc' | 'location';
        entity_name: string;
        faction_name: string;
        role?: string;
        action: 'JOIN' | 'LEAVE';
    }>;
    // 🆕 Artifacts
    artifacts?: Array<{
        name: string;
        description?: string;
        effects?: string;
        is_cursed?: boolean;
        curse_description?: string;
        owner_type?: string;
        owner_name?: string;
        location_macro?: string;
        location_micro?: string;
        faction_name?: string;
        status?: string;
    }>;
    // 🆕 Artifact Events
    artifact_events?: Array<{
        name: string;
        event: string;
        type: 'ACTIVATION' | 'DESTRUCTION' | 'TRANSFER' | 'REVELATION' | 'CURSE' | 'GENERIC';
    }>;
    // 🆕 Party Alignment
    party_alignment_change?: {
        id?: string;
        moral_impact?: number;
        ethical_impact?: number;
        reason: string;
    };
}

// --- VALIDATION BATCH ---
export interface ValidationBatchInput {
    npc_events?: Array<{ id?: string; name: string; event: string; type: string }>;
    character_events?: Array<{ id?: string; name: string; event: string; type: string }>;
    world_events?: Array<{ id?: string; event: string; type: string }>;
    artifact_events?: Array<{ id?: string; name: string; event: string; type: string }>;
    loot?: Array<{ id?: string; name: string; quantity?: number; description?: string }>;
    loot_removed?: Array<{ id?: string; name: string; quantity?: number; description?: string }>;
    quests?: Array<{ id?: string; title: string; description?: string; status?: string }>;
    atlas_update?: {
        macro: string;
        micro: string;
        description: string;
        existingDesc?: string;
    };
}

export interface ValidationBatchOutput {
    npc_events: { keep: any[]; skip: string[] };
    character_events: { keep: any[]; skip: string[] };
    world_events: { keep: any[]; skip: string[] };
    artifact_events: { keep: any[]; skip: string[] };
    loot: { keep: Array<{ name: string; quantity?: number; description?: string }>; skip: string[] };
    loot_removed: { keep: Array<{ name: string; quantity?: number; description?: string }>; skip: string[] };
    quests: { keep: Array<{ title: string; description?: string; status?: string }>; skip: string[] };
    atlas: { action: 'keep' | 'skip' | 'merge'; text?: string };
}

// --- ANALYST OUTPUT ---
export interface AnalystOutput {
    loot: Array<{ name: string; quantity?: number; description?: string }>;
    loot_removed: Array<{ name: string; quantity?: number; description?: string }>;
    quests: Array<{ title: string; description?: string; status?: string }>;
    monsters: Array<{
        name: string;
        status: string;
        count?: string;
        description?: string;
        abilities?: string[];
        weaknesses?: string[];
        resistances?: string[];
    }>;
    npc_dossier_updates: Array<{
        id?: string;  // 🆕 Short ID for direct lookup
        name: string;
        description: string;
        role?: string;
        status?: 'ALIVE' | 'DEAD' | 'MISSING';
        alignment_moral?: 'BUONO' | 'NEUTRALE' | 'CATTIVO';
        alignment_ethical?: 'LEGALE' | 'NEUTRALE' | 'CAOTICO';
    }>;
    location_updates: Array<{ id?: string; macro: string; micro: string; description: string }>;  // 🆕 id for direct lookup
    travel_sequence: Array<{ macro: string; micro: string; reason?: string }>;
    present_npcs: string[];
    // Moved from Writer
    log: string[];
    character_growth: Array<{
        id?: string;  // 🆕 Short ID of the character
        name: string;
        event: string;
        type: 'BACKGROUND' | 'TRAUMA' | 'RELATIONSHIP' | 'ACHIEVEMENT' | 'GOAL_CHANGE';
        moral_impact?: number;   // -10 to +10
        ethical_impact?: number; // -10 to +10
        faction_id?: string;     // 5-char short ID if event targets a specific external faction
    }>;
    npc_events: Array<{
        id?: string;  // 🆕 Short ID of the NPC
        name: string;
        event: string;
        type: 'REVELATION' | 'BETRAYAL' | 'DEATH' | 'ALLIANCE' | 'STATUS_CHANGE' | 'GENERIC';
        moral_impact?: number;   // -10 to +10
        ethical_impact?: number; // -10 to +10
        faction_id?: string;     // 5-char short ID if event targets a specific faction
    }>;

    world_events: Array<{
        event: string;
        type: 'WAR' | 'POLITICS' | 'DISCOVERY' | 'CALAMITY' | 'SUPERNATURAL' | 'GENERIC';
    }>;
    // 🆕 Faction System
    faction_updates: Array<{
        id?: string;  // 🆕 Short ID for direct lookup
        name: string;
        description?: string;
        type?: 'GUILD' | 'KINGDOM' | 'CULT' | 'ORGANIZATION' | 'GENERIC';
        alignment_moral?: 'BUONO' | 'NEUTRALE' | 'CATTIVO';  // 🆕
        alignment_ethical?: 'LEGALE' | 'NEUTRALE' | 'CAOTICO';  // 🆕
        reputation_change?: {
            direction: 'UP' | 'DOWN';
            reason: string;
        };
    }>;
    faction_affiliations: Array<{
        entity_id?: string;  // 🆕 Short ID of the entity for direct lookup
        entity_type: 'npc' | 'location';
        entity_name: string;
        faction_id?: string;  // 🆕 Short ID of the faction
        faction_name: string;
        role?: 'LEADER' | 'MEMBER' | 'ALLY' | 'ENEMY' | 'CONTROLLED';
        action: 'JOIN' | 'LEAVE';
    }>;
    // 🆕 Party Alignment
    party_alignment_change?: {
        id?: string;           // short_id della faction party
        moral_impact?: number; // -10 a +10
        ethical_impact?: number; // -10 a +10
        reason: string;
    };
    // 🆕 Artifacts
    artifacts: Array<{
        id?: string;  // 🆕 Short ID for direct lookup
        name: string;
        description?: string;
        effects?: string;
        is_cursed?: boolean;
        curse_description?: string;
        owner_type?: 'PC' | 'NPC' | 'FACTION' | 'LOCATION' | 'NONE';
        owner_name?: string;
        location_macro?: string;
        location_micro?: string;
        faction_name?: string;
        status?: 'FUNZIONANTE' | 'DISTRUTTO' | 'PERDUTO' | 'SIGILLATO' | 'DORMIENTE';
    }>;
    // 🆕 Artifact Events
    artifact_events: Array<{
        id?: string;  // 🆕 Short ID of the artifact
        name: string;
        event: string;
        type: 'ACTIVATION' | 'DESTRUCTION' | 'TRANSFER' | 'REVELATION' | 'CURSE' | 'GENERIC';
    }>;
}
