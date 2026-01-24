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
    quests?: string[];
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
}

// --- VALIDATION BATCH ---
export interface ValidationBatchInput {
    npc_events?: Array<{ name: string; event: string; type: string }>;
    character_events?: Array<{ name: string; event: string; type: string }>;
    world_events?: Array<{ event: string; type: string }>;
    loot?: Array<{ name: string; quantity?: number; description?: string }>;
    quests?: string[];
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
    loot: { keep: Array<{ name: string; quantity?: number; description?: string }>; skip: string[] };
    quests: { keep: string[]; skip: string[] };
    atlas: { action: 'keep' | 'skip' | 'merge'; text?: string };
}

// --- ANALYST OUTPUT ---
export interface AnalystOutput {
    loot: Array<{ name: string; quantity?: number; description?: string }>;
    loot_removed: Array<{ name: string; quantity?: number; description?: string }>;
    quests: string[];
    monsters: Array<{
        name: string;
        status: string;
        count?: string;
        description?: string;
        abilities?: string[];
        weaknesses?: string[];
        resistances?: string[];
    }>;
    npc_dossier_updates: Array<{ name: string; description: string; role?: string; status?: 'ALIVE' | 'DEAD' | 'MISSING' }>;
    location_updates: Array<{ macro: string; micro: string; description: string }>;
    travel_sequence: Array<{ macro: string; micro: string; reason?: string }>;
    present_npcs: string[];
    // Moved from Writer
    log: string[];
    character_growth: Array<{
        name: string;
        event: string;
        type: 'BACKGROUND' | 'TRAUMA' | 'RELATIONSHIP' | 'ACHIEVEMENT' | 'GOAL_CHANGE';
    }>;
    npc_events: Array<{
        name: string;
        event: string;
        type: 'REVELATION' | 'BETRAYAL' | 'DEATH' | 'ALLIANCE' | 'STATUS_CHANGE' | 'GENERIC';
    }>;
    world_events: Array<{
        event: string;
        type: 'WAR' | 'POLITICS' | 'DISCOVERY' | 'CALAMITY' | 'SUPERNATURAL' | 'GENERIC';
    }>;
}
