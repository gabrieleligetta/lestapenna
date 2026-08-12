/**
 * Column whitelists for the entity list endpoints.
 *
 * Endpoints used to return `SELECT *` rows straight from the repositories,
 * which leaked plumbing columns (`rag_sync_needed`, `last_synced_history_id`,
 * `first_session_id`, …) and forced the SPA to keep its own HIDDEN_DETAIL_FIELDS
 * blocklist. Declaring the allowed columns once here means the DTO and the
 * response are derived from the same source, and anything new added to a table
 * stays invisible until somebody opts it in.
 */

/** Narrow an arbitrary repository row down to the whitelisted keys. */
export function pick<T extends object, K extends readonly (keyof T & string)[]>(
    row: T,
    fields: K,
): Pick<T, K[number]> {
    const out = {} as Pick<T, K[number]>;
    for (const field of fields) {
        out[field] = row[field];
    }
    return out;
}

export const NPC_FIELDS = [
    'short_id',
    'name',
    'role',
    'status',
    'description',
    'aliases',
    'alignment_moral',
    'alignment_ethical',
    'moral_score',
    'ethical_score',
    'last_updated',
] as const;

export const LOCATION_FIELDS = [
    'short_id',
    'macro_location',
    'micro_location',
    'description',
    'last_updated',
] as const;

export const FACTION_FIELDS = [
    'short_id',
    'name',
    'description',
    'type',
    'status',
    'is_party',
    'alignment_moral',
    'alignment_ethical',
    'moral_score',
    'ethical_score',
    'last_updated',
] as const;

export const QUEST_FIELDS = [
    'short_id',
    'title',
    'description',
    'status',
    'type',
    'session_id',
    'last_updated',
] as const;

/**
 * `is_artifact` and the `artifact_*` columns are not on the inventory table:
 * they come from getInventoryWithArtifactInfo's LEFT JOIN onto artifacts.
 */
export const INVENTORY_FIELDS = [
    'short_id',
    'item_name',
    'description',
    'quantity',
    'category',
    'notes',
    'last_updated',
    'is_artifact',
    'artifact_short_id',
    'artifact_status',
    'is_cursed',
] as const;

export const ARTIFACT_FIELDS = [
    'short_id',
    'name',
    'description',
    'effects',
    'status',
    'is_cursed',
    'curse_description',
    'owner_type',
    'owner_id',
    'owner_name',
    'location_macro',
    'location_micro',
    'faction_id',
    'last_updated',
] as const;

/** abilities/weaknesses/resistances/variants are JSON-encoded TEXT, parsed in the mapper. */
export const BESTIARY_FIELDS = [
    'short_id',
    'name',
    'description',
    'status',
    'abilities',
    'weaknesses',
    'resistances',
    'variants',
    'notes',
    'last_seen',
] as const;

export const CHARACTER_FIELDS = [
    'user_id',
    'character_name',
    'race',
    'class',
    'description',
    'foundation_description',
    'alignment_moral',
    'alignment_ethical',
    'moral_score',
    'ethical_score',
] as const;

export const TIMELINE_FIELDS = [
    'short_id',
    'year',
    'event_type',
    'description',
    'session_id',
    'timestamp',
] as const;

/** Weights exist only on npc/character/faction history: elsewhere they stay null. */
export const HISTORY_EVENT_FIELDS = [
    'id',
    'description',
    'event_type',
    'session_id',
    'timestamp',
    'is_manual',
    'moral_weight',
    'ethical_weight',
] as const;
