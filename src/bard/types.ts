/**
 * Bard Types - All interfaces and type definitions
 */
import type {
    QuestLifecycleConfidence,
    QuestStatus,
    QuestType
} from '../db/types';

export interface QuestLifecycleDecision {
    id?: string;
    title: string;
    current_status?: QuestStatus;
    proposed_status: QuestStatus;
    description: string;
    type: QuestType;
    evidence: string;
    confidence: QuestLifecycleConfidence;
    action: 'NO_CHANGE' | 'STATUS_CHANGE' | 'CREATE';
}

export interface QuestLifecycleOutput {
    decisions: QuestLifecycleDecision[];
}

// --- TONES ---
// Single source in prompts.ts (AI instructions in canonical English); only a re-export
// here for the historical consumers that come through the barrel.
export { TONES, type ToneKey } from './prompts';

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
    }>;
    present_npcs?: string[];
}

// --- SUMMARY RESPONSE ---
export interface SummaryResponse {
    /** Long summary (the full narration). */
    summary: string;
    title: string;
    tokens: number;
    loot?: Array<{ name: string; quantity?: number; description?: string }>;
    loot_removed?: Array<{ name: string; quantity?: number; description?: string }>;
    quests?: Array<{ id?: string; title: string; description?: string; status?: string; type?: 'MAJOR' | 'MINOR' }>;
    quest_lifecycle?: QuestLifecycleOutput;
    /** Short summary (a single text; any acts have already been joined). */
    narrativeBrief?: string;
    log?: string[];
    character_growth?: Array<{
        name: string;
        event: string;
        type: 'BACKGROUND' | 'TRAUMA' | 'RELATIONSHIP' | 'ACHIEVEMENT' | 'GOAL_CHANGE';
    }>;
    npc_events?: Array<{
        name: string;
        event: string;
        type: 'FIRST_APPEARANCE' | 'REVELATION' | 'BETRAYAL' | 'DEATH' | 'ALLIANCE' | 'STATUS_CHANGE' | 'COMBAT' | 'INTERACTION' | 'ABILITY_REVEALED' | 'GENERIC';
    }>;
    world_events?: Array<{
        event: string;
        type: 'WAR' | 'POLITICS' | 'DISCOVERY' | 'CALAMITY' | 'SUPERNATURAL' | 'GENERIC' | 'DISASTER' | 'MYTH' | 'RELIGION' | 'BIRTH' | 'DEATH' | 'CONSTRUCTION';
    }>;
    monsters?: Array<{
        name: string;
        status: string;
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
    // 🆕 Last known position of each NPC present (macro/micro as in travel_sequence).
    // Used to set last_seen_location by resolving against the DB atlas.
    npc_locations?: Array<{ name: string; location_id?: string; macro?: string; micro?: string }>;
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
            value: number;
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
        type: 'ACTIVATION' | 'DESTRUCTION' | 'TRANSFER' | 'REVELATION' | 'CURSE' | 'GENERIC' | 'DISCOVERY' | 'CURSE_REVEAL' | 'OBSERVATION' | 'MANUAL_UPDATE';
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
    quests?: Array<{ id?: string; title: string; description?: string; status?: string; type?: string }>;
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
    quests: { keep: Array<{ id?: string; title: string; description?: string; status?: string; type?: string }>; skip: string[] };
    atlas: { action: 'keep' | 'skip' | 'merge'; text?: string };
}

// --- ANALYST OUTPUT ---
export interface AnalystOutput {
    loot: Array<{ name: string; quantity?: number; description?: string }>;
    loot_removed: Array<{ name: string; quantity?: number; description?: string }>;
    quests: Array<{ id?: string; title: string; description?: string; status?: string; type?: 'MAJOR' | 'MINOR' }>;
    quest_lifecycle?: QuestLifecycleOutput;
    monsters: Array<{
        name: string;
        status: string;
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
        alignment_moral?: 'GOOD' | 'NEUTRAL' | 'EVIL';
        alignment_ethical?: 'LAWFUL' | 'NEUTRAL' | 'CHAOTIC';
    }>;
    location_updates: Array<{ id?: string; macro: string; micro: string; description: string }>;  // 🆕 id for direct lookup
    travel_sequence: Array<{ macro: string; micro: string; reason?: string }>;
    present_npcs: string[];
    // 🆕 Last known position of each NPC present (macro/micro as in travel_sequence).
    npc_locations: Array<{ name: string; location_id?: string; macro?: string; micro?: string }>;
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
        type: 'FIRST_APPEARANCE' | 'REVELATION' | 'BETRAYAL' | 'DEATH' | 'ALLIANCE' | 'STATUS_CHANGE' | 'COMBAT' | 'INTERACTION' | 'ABILITY_REVEALED' | 'GENERIC';
        moral_impact?: number;   // -10 to +10
        ethical_impact?: number; // -10 to +10
        faction_id?: string;     // 5-char short ID if event targets a specific faction
    }>;

    world_events: Array<{
        event: string;
        type: 'WAR' | 'POLITICS' | 'DISCOVERY' | 'CALAMITY' | 'SUPERNATURAL' | 'GENERIC' | 'DISASTER' | 'MYTH' | 'RELIGION' | 'BIRTH' | 'DEATH' | 'CONSTRUCTION';
    }>;
    // 🆕 Faction System
    faction_updates: Array<{
        id?: string;  // 🆕 Short ID for direct lookup
        name: string;
        description?: string;
        type?: 'GUILD' | 'KINGDOM' | 'CULT' | 'ORGANIZATION' | 'GENERIC';
        alignment_moral?: 'GOOD' | 'NEUTRAL' | 'EVIL';  // 🆕
        alignment_ethical?: 'LAWFUL' | 'NEUTRAL' | 'CHAOTIC';  // 🆕
        reputation_change?: {
            value: number;
            reason: string;
        };
    }>;
    faction_affiliations: Array<{
        entity_id?: string;  // 🆕 Short ID of the entity for direct lookup
        entity_type: 'npc' | 'location';
        entity_name: string;
        faction_id?: string;  // 🆕 Short ID of the faction
        faction_name: string;
        role?: 'LEADER' | 'MEMBER' | 'ALLY' | 'ENEMY' | 'CONTROLLED' | 'HQ' | 'PRESENCE' | 'HOSTILE' | 'PRISONER';
        action: 'JOIN' | 'LEAVE';
    }>;
    // 🆕 Party Alignment
    party_alignment_change?: {
        id?: string;           // short_id of the party faction
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
        status?: 'FUNCTIONAL' | 'DESTROYED' | 'LOST' | 'SEALED' | 'DORMANT';
    }>;
    // 🆕 Artifact Events
    artifact_events: Array<{
        id?: string;  // 🆕 Short ID of the artifact
        name: string;
        event: string;
        type: 'ACTIVATION' | 'DESTRUCTION' | 'TRANSFER' | 'REVELATION' | 'CURSE' | 'GENERIC' | 'DISCOVERY' | 'CURSE_REVEAL' | 'OBSERVATION' | 'MANUAL_UPDATE';
    }>;
}
