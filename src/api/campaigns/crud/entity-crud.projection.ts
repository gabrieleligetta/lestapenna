import {
    ARTIFACT_FIELDS,
    BESTIARY_FIELDS,
    FACTION_FIELDS,
    INVENTORY_FIELDS,
    LOCATION_FIELDS,
    NPC_FIELDS,
    QUEST_FIELDS,
    TIMELINE_FIELDS,
    pick,
} from '../dto/projections';
import type { CrudEntityType, CrudRow } from './entity-crud.registry';

/**
 * The columns a mutation may return, per family.
 *
 * They are the same whitelists as the lists: a create must not be able to leak
 * `rag_sync_needed` or `manual_description` just because it comes from another route.
 */
const FIELDS_BY_ENTITY: Record<CrudEntityType, readonly string[]> = {
    npcs: NPC_FIELDS,
    locations: LOCATION_FIELDS,
    factions: FACTION_FIELDS,
    quests: QUEST_FIELDS,
    // is_artifact and the artifact_* fields come from the list's LEFT JOIN and
    // do not exist on the raw inventory row: pick simply leaves them
    // undefined, and the client re-reads them from the detail.
    inventory: INVENTORY_FIELDS,
    artifacts: ARTIFACT_FIELDS,
    bestiary: BESTIARY_FIELDS,
    timeline: TIMELINE_FIELDS,
};

export function projectEntity(entityType: CrudEntityType, row: CrudRow): Record<string, unknown> {
    const fields = FIELDS_BY_ENTITY[entityType];
    const projected = pick(row as Record<string, unknown>, fields as never) as Record<string, unknown>;
    // Columns absent from the raw row stay out instead of showing up
    // as `undefined` in the JSON.
    return Object.fromEntries(Object.entries(projected).filter(([, value]) => value !== undefined));
}
