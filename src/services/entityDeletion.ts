/**
 * Cascade deletion of a campaign entity.
 *
 * It lives in the domain, not under `src/api/`, because it has two callers: the
 * web CRUD and the Discord commands. Stopping at the entity row — as every
 * `$... delete` of the bot used to — leaves the history orphaned and, above all,
 * the RAG card intact: the Bardo keeps answering about an NPC that the list
 * shows as deleted.
 *
 * The storage differences between the eight families all live here, as is
 * already the case for merge in `api/campaigns/merge/merge-entity.registry.ts`.
 */

import { db } from '../db/client';
import {
    artifactRepository,
    bestiaryRepository,
    entityMediaRepository,
    factionRepository,
    inventoryRepository,
    knowledgeRepository,
    locationRepository,
    npcRepository,
    questRepository,
    worldRepository,
} from '../db';
import type { EntityFragmentQuery } from '../db/repositories/KnowledgeRepository';
import { EntityMediaStorage } from './entityMediaStorage';
import { logger } from '../utils/logger';

const log = logger('EntityDeletion');

/**
 * The entity families that can be managed end to end (creation, editing,
 * deletion).
 *
 * `characters` and `sessions` are deliberately left out: a character is born
 * from a Discord user and a session from a recording, so "create" and
 * "delete" there are not record operations but account and archive ones.
 */
export const CRUD_ENTITY_TYPES = [
    'npcs',
    'locations',
    'factions',
    'quests',
    'inventory',
    'artifacts',
    'bestiary',
    'timeline',
] as const;

export type CrudEntityType = typeof CRUD_ENTITY_TYPES[number];

export function isCrudEntityType(value: unknown): value is CrudEntityType {
    return typeof value === 'string' && (CRUD_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * The repositories' entities are closed interfaces (NpcEntry, FactionEntry, …);
 * here they are needed as generic records, and each spec knows which columns it reads.
 */
export interface CrudRow {
    id: number;
    short_id?: string | null;
    [key: string]: unknown;
}

export function asRow(value: unknown): CrudRow | null {
    return (value ?? null) as CrudRow | null;
}

/**
 * How an entity's history is reached.
 *
 * `keyColumns` are the columns that tie a history row to its entity:
 * one for almost all of them (`npc_name`), two for the atlas, which is the only
 * history with a composite macro+micro key instead of being id-first.
 */
export interface HistorySpec {
    table: string;
    keyColumns: readonly string[];
    /** `true` when the table has `entity_id` (a stable link across renames). */
    hasEntityId: boolean;
    /** The values of `keyColumns` for this entity, in the same order. */
    keyValues(row: CrudRow): string[];
    /** The history rows, exactly as the GET endpoint already reads them. */
    list(campaignId: number, row: CrudRow): unknown[];
}

/** What is needed to delete an entity and everything that names it. */
export interface EntityDeleteSpec {
    /** `null` for the timeline: a world event has no history of its own. */
    history: HistorySpec | null;
    /** Prefix of the typed references in the RAG fragments (`npc:12`). */
    ragRefType: string | null;
    /** Readable name, for user-facing messages and history keys. */
    label(row: CrudRow): string;
    /** Deletes the entity row alone: `deleteEntityCascade` does the rest. */
    remove(campaignId: number, current: CrudRow): boolean;
    /** Deletes the entity's dedicated RAG card (`[[SCHEDA ... UFFICIALE]]`). */
    deleteRagSummary(campaignId: number, current: CrudRow): void;
    /** How the memory fragments that talk about this entity are recognized. */
    fragmentQuery(current: CrudRow): EntityFragmentQuery;
    /** Why the entity cannot be deleted, or `null` when it can. */
    deleteBlockedReason?(current: CrudRow): string | null;
}

/** The families that can have an uploaded image (entity_media). */
const MEDIA_TYPE_BY_ENTITY: Partial<Record<CrudEntityType, 'npc' | 'location' | 'artifact'>> = {
    npcs: 'npc',
    locations: 'location',
    artifacts: 'artifact',
};

/** The families that can appear in faction_affiliations. */
const AFFILIATION_TYPE_BY_ENTITY: Partial<Record<CrudEntityType, 'npc' | 'location'>> = {
    npcs: 'npc',
    locations: 'location',
};

export const ENTITY_DELETE_SPECS: Record<CrudEntityType, EntityDeleteSpec> = {
    npcs: {
        history: {
            table: 'npc_history',
            keyColumns: ['npc_name'],
            hasEntityId: true,
            keyValues: (row) => [String(row.name)],
            list: (campaignId, row) => npcRepository.getNpcHistory(campaignId, String(row.name)),
        },
        ragRefType: 'npc',
        label: (row) => String(row.name),
        remove: (campaignId, current) => npcRepository.deleteNpcEntry(campaignId, String(current.name)),
        deleteRagSummary: (campaignId, current) =>
            knowledgeRepository.deleteNpcRagSummary(campaignId, String(current.name)),
        // NPCs are the only family with three generations of references alive
        // at once: typed ref, legacy id and the name in the JSON.
        fragmentQuery: (current) => ({
            snapshotSessionId: 'DOSSIER_UPDATE',
            headerNeedle: `[[SCHEDA UFFICIALE: ${current.name}]]`,
            entityRef: `npc:${current.id}`,
            legacyNpcId: current.id,
            associatedName: String(current.name),
        }),
    },

    locations: {
        history: {
            table: 'atlas_history',
            keyColumns: ['macro_location', 'micro_location'],
            hasEntityId: false,
            keyValues: (row) => [String(row.macro_location), String(row.micro_location)],
            list: (campaignId, row) =>
                locationRepository.getAtlasHistory(
                    campaignId,
                    String(row.macro_location),
                    String(row.micro_location),
                ),
        },
        ragRefType: 'loc',
        label: (row) => `${row.macro_location} — ${row.micro_location}`,
        remove: (campaignId, current) =>
            locationRepository.deleteAtlasEntry(
                campaignId,
                String(current.macro_location),
                String(current.micro_location),
            ),
        deleteRagSummary: (campaignId, current) =>
            knowledgeRepository.deleteAtlasRagSummary(
                campaignId,
                String(current.macro_location),
                String(current.micro_location),
            ),
        // The atlas indexes its cards on the macro/micro columns; the header
        // still covers the snapshots written before those columns existed.
        fragmentQuery: (current) => ({
            snapshotSessionId: 'ATLAS_UPDATE',
            headerNeedle: `[[SCHEDA LUOGO UFFICIALE: ${current.macro_location} - ${current.micro_location}]]`,
            location: { macro: String(current.macro_location), micro: String(current.micro_location) },
            entityRef: `loc:${current.id}`,
        }),
    },

    factions: {
        history: {
            table: 'faction_history',
            keyColumns: ['faction_name'],
            hasEntityId: true,
            keyValues: (row) => [String(row.name)],
            list: (campaignId, row) => factionRepository.getFactionHistory(campaignId, String(row.name)),
        },
        ragRefType: 'faction',
        label: (row) => String(row.name),
        remove: (campaignId, current) => factionRepository.deleteFaction(campaignId, String(current.name)),
        deleteRagSummary: (campaignId, current) => {
            knowledgeRepository.deleteFactionRagSummary(campaignId, String(current.name));
        },
        fragmentQuery: (current) => ({
            snapshotSessionId: 'FACTION_UPDATE',
            headerNeedle: `[[SCHEDA FAZIONE UFFICIALE: ${current.name}]]`,
            entityRef: `faction:${current.id}`,
            associatedName: String(current.name),
        }),
        // Mirrors MERGE_ENTITY_SPECS.factions: the party faction is
        // structural, and the campaign derives its group alignment from it.
        deleteBlockedReason: (current) =>
            current.is_party === 1 ? 'The Party faction cannot be deleted' : null,
    },

    quests: {
        history: {
            table: 'quest_history',
            keyColumns: ['quest_title'],
            hasEntityId: true,
            keyValues: (row) => [String(row.title)],
            list: (campaignId, row) => questRepository.getQuestHistory(campaignId, String(row.title)),
        },
        ragRefType: 'quest',
        label: (row) => String(row.title),
        // deleteQuest already cascades on its own (history + RAG + lifecycle proposals).
        remove: (_campaignId, current) => questRepository.deleteQuest(current.id),
        deleteRagSummary: () => undefined,
        fragmentQuery: (current) => ({
            snapshotSessionId: 'QUEST_UPDATE',
            headerNeedle: `: ${current.title}]]`,
            entityRef: `quest:${current.id}`,
        }),
    },

    inventory: {
        history: {
            table: 'inventory_history',
            keyColumns: ['item_name'],
            hasEntityId: true,
            keyValues: (row) => [String(row.item_name)],
            list: (campaignId, row) =>
                inventoryRepository.getInventoryHistory(campaignId, String(row.item_name)),
        },
        ragRefType: 'item',
        label: (row) => String(row.item_name),
        remove: (campaignId, current) =>
            inventoryRepository.deleteInventoryItem(campaignId, String(current.item_name)),
        deleteRagSummary: (campaignId, current) =>
            knowledgeRepository.deleteInventoryRagSummary(campaignId, String(current.item_name)),
        fragmentQuery: (current) => ({
            snapshotSessionId: 'INVENTORY_UPDATE',
            headerNeedle: `: ${current.item_name}]]`,
            entityRef: `item:${current.id}`,
        }),
    },

    artifacts: {
        history: {
            table: 'artifact_history',
            keyColumns: ['artifact_name'],
            hasEntityId: true,
            keyValues: (row) => [String(row.name)],
            list: (campaignId, row) => artifactRepository.getArtifactHistory(campaignId, String(row.name)),
        },
        // Artifacts never got a typed reference prefix.
        ragRefType: null,
        label: (row) => String(row.name),
        remove: (campaignId, current) => artifactRepository.deleteArtifact(campaignId, String(current.name)),
        deleteRagSummary: (campaignId, current) =>
            knowledgeRepository.deleteArtifactRagSummary(campaignId, String(current.name)),
        fragmentQuery: (current) => ({
            snapshotSessionId: 'ARTIFACT_UPDATE',
            headerNeedle: `[[SCHEDA ARTEFATTO UFFICIALE: ${current.name}]]`,
        }),
    },

    bestiary: {
        history: {
            table: 'bestiary_history',
            keyColumns: ['monster_name'],
            hasEntityId: true,
            keyValues: (row) => [String(row.name)],
            list: (campaignId, row) => bestiaryRepository.getBestiaryHistory(campaignId, String(row.name)),
        },
        ragRefType: 'monster',
        label: (row) => String(row.name),
        remove: (campaignId, current) => bestiaryRepository.deleteMonster(campaignId, String(current.name)),
        deleteRagSummary: (campaignId, current) =>
            knowledgeRepository.deleteBestiaryRagSummary(campaignId, String(current.name)),
        fragmentQuery: (current) => ({
            snapshotSessionId: 'BESTIARY_UPDATE',
            headerNeedle: `: ${current.name}]]`,
            entityRef: `monster:${current.id}`,
        }),
    },

    timeline: {
        // A world event already is the event: it has no history of its own.
        history: null,
        ragRefType: null,
        label: (row) => String(row.description).slice(0, 80),
        remove: (_campaignId, current) => worldRepository.deleteWorldEvent(current.id),
        deleteRagSummary: () => undefined,
        // `ingestWorldEvent` writes the event inside the fragment of the session
        // in which it was narrated, so the only anchor is the text.
        fragmentQuery: (current) => ({ headerNeedle: String(current.description) }),
    },
};

export interface EntityDeleteReport {
    history_deleted: number;
    rag_fragments_deleted: number;
    rag_refs_stripped: number;
    affiliations_deleted: number;
    media_deleted: boolean;
}

export interface EntityDeleteOutcome {
    report: EntityDeleteReport;
    /** Keys of the storage objects left to delete outside the transaction. */
    mediaObjectKeys: string[];
}

/** The entity exists but cannot be deleted (today: only the party faction). */
export class EntityDeleteBlockedError extends Error {}

/**
 * Every history row of the entity, id-first where the table has
 * `entity_id` — the legacy rows stay reachable by name, as in
 * `getHistoryByEntity`.
 */
function deleteHistory(campaignId: number, history: HistorySpec, row: CrudRow): number {
    const values = history.keyValues(row);
    const nameClause = history.keyColumns
        .map((column) => `lower(${column}) = lower(?)`)
        .join(' AND ');
    const clause = history.hasEntityId
        ? `(entity_id = ? OR (entity_id IS NULL AND ${nameClause}))`
        : nameClause;
    const params = history.hasEntityId ? [row.id, ...values] : values;

    return db.prepare(
        `DELETE FROM ${history.table} WHERE campaign_id = ? AND ${clause}`,
    ).run(campaignId, ...params).changes;
}

/**
 * Deletes the entity and everything that names it, in a transaction.
 *
 * `row` must already be resolved by the caller (short-id, name, wizard…): nothing
 * is looked up here, so the function does not have to know the different ways
 * web and bot identify an entity.
 *
 * Media live on object storage and cannot be deleted inside a SQLite
 * transaction: their keys are returned to the caller, who passes them to
 * `purgeOrphanedMediaObjects` after the commit.
 */
export function deleteEntityCascade(
    campaignId: number,
    entityType: CrudEntityType,
    row: CrudRow,
): EntityDeleteOutcome {
    const spec = ENTITY_DELETE_SPECS[entityType];

    const blocked = spec.deleteBlockedReason?.(row);
    if (blocked) throw new EntityDeleteBlockedError(blocked);

    const report: EntityDeleteReport = {
        history_deleted: 0,
        rag_fragments_deleted: 0,
        rag_refs_stripped: 0,
        affiliations_deleted: 0,
        media_deleted: false,
    };
    const mediaObjectKeys: string[] = [];
    const mediaType = MEDIA_TYPE_BY_ENTITY[entityType];
    let removed = false;

    db.transaction(() => {
        const fragments = knowledgeRepository.listEntityFragments(campaignId, spec.fragmentQuery(row));

        if (spec.history) {
            report.history_deleted = deleteHistory(campaignId, spec.history, row);
        }

        // First the fragments found by the query — that is the one the panel
        // shows the user, and the report has to count them all. Only afterwards
        // `deleteRagSummary`, as a net for the snapshots in legacy formats
        // the query does not recognize: reversing the order would delete the
        // official card and the loop would count it zero times.
        for (const fragment of fragments) {
            if (knowledgeRepository.deleteFragment(campaignId, fragment.id)) {
                report.rag_fragments_deleted++;
            }
        }
        spec.deleteRagSummary(campaignId, row);

        if (spec.ragRefType) {
            report.rag_refs_stripped = knowledgeRepository.removeEntityRagRefs(
                campaignId,
                `${spec.ragRefType}:${row.id}`,
            );
        }

        const affiliationType = AFFILIATION_TYPE_BY_ENTITY[entityType];
        if (affiliationType) {
            report.affiliations_deleted = db.prepare(
                'DELETE FROM faction_affiliations WHERE entity_type = ? AND entity_id = ?',
            ).run(affiliationType, row.id).changes;
        }

        if (mediaType) {
            const media = entityMediaRepository.deleteForEntity(campaignId, mediaType, String(row.id));
            if (media.length > 0) {
                report.media_deleted = true;
                for (const picture of media) {
                    mediaObjectKeys.push(picture.display_object_key, picture.thumbnail_object_key);
                }
            }
        }

        removed = spec.remove(campaignId, row);
    })();

    if (!removed) {
        // The entity row was already gone: SQLite only rolls the transaction back
        // on an exception, so we report it here.
        throw new Error(`${entityType} entry could not be deleted`);
    }

    return { report, mediaObjectKeys };
}

/**
 * Deletes the storage objects left orphaned after the cascade.
 *
 * Best-effort by construction: the entity is already gone, and a storage error
 * must not turn a successful deletion into a failure.
 */
export async function purgeOrphanedMediaObjects(objectKeys: string[]): Promise<void> {
    if (objectKeys.length === 0) return;
    let storage: EntityMediaStorage;
    try {
        storage = new EntityMediaStorage();
    } catch {
        return; // Storage not configured: nothing to clean up.
    }
    if (!storage.isEnabled()) return;

    const results = await Promise.allSettled(objectKeys.map((key) => storage.delete(key)));
    results.forEach((result, index) => {
        if (result.status === 'rejected') {
            log.error(
                `Orphaned media object after entity deletion: ${objectKeys[index]}`,
                result.reason as Error,
            );
        }
    });
}
