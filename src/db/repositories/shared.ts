/**
 * Helpers shared between the repositories (functions, not a base class: the 17
 * repos have subtly different shapes and inheritance would force a uniformity
 * that does not exist).
 */

import { db } from '../client';
import {
    getMoralAlignment,
    getEthicalAlignment,
    computeAggregatedAlignmentScore
} from '../../utils/alignmentUtils';

/**
 * Lookup by short-id (5 chars, leading # tolerated) on any entity table.
 * It used to be re-implemented identically in 8 repositories.
 * `table` must be a static table name, never user input.
 */
export function getByShortId<T>(
    table: string,
    campaignId: number,
    shortId: string,
    opts: { orderBy?: string } = {}
): T | null {
    const cleanId = shortId.trim().replace(/^#/, '').toLowerCase();
    const orderClause = opts.orderBy ? ` ORDER BY ${opts.orderBy}` : '';
    return db.prepare(
        `SELECT * FROM ${table} WHERE campaign_id = ? AND lower(short_id) = ?${orderClause} LIMIT 1`
    ).get(campaignId, cleanId) as T | null;
}

/**
 * Parent entity id by name (case-insensitive); null when it does not exist.
 * `parentTable`/`parentNameCol` must be static, never user input.
 * This lookup used to be duplicated identically across the 6 add*Event.
 */
export function resolveEntityId(
    parentTable: string,
    parentNameCol: string,
    campaignId: number,
    name: string
): number | null {
    const row = db.prepare(
        `SELECT id FROM ${parentTable} WHERE campaign_id = ? AND lower(${parentNameCol}) = lower(?)`
    ).get(campaignId, name) as { id: number } | undefined;
    return row?.id ?? null;
}

/**
 * Id-first history read: rows linked via entity_id follow the entity even after
 * a rename/merge; legacy rows (entity_id NULL) stay reachable by name.
 * Tables/columns are static, never user input.
 */
export function getHistoryByEntity<T>(
    historyTable: string,
    historyNameCol: string,
    parentTable: string,
    parentNameCol: string,
    campaignId: number,
    name: string,
    opts: { orderBy?: string } = {}
): T[] {
    const orderClause = `ORDER BY ${opts.orderBy || 'timestamp ASC'}`;
    const entityId = resolveEntityId(parentTable, parentNameCol, campaignId, name);
    if (entityId === null) {
        // Padre inesistente: puro match per nome (comportamento legacy)
        return db.prepare(`
            SELECT * FROM ${historyTable}
            WHERE campaign_id = ? AND lower(${historyNameCol}) = lower(?)
            ${orderClause}
        `).all(campaignId, name) as T[];
    }
    const linked = db.prepare(`
        SELECT * FROM ${historyTable}
        WHERE campaign_id = ?
          AND (entity_id = ? OR (entity_id IS NULL AND lower(${historyNameCol}) = lower(?)))
        ${orderClause}
    `).all(campaignId, entityId, name) as T[];
    if (linked.length > 0) return linked;

    // Some legacy DBs received wrong entity_ids during the backfill in the
    // presence of case-variant duplicates: the historical name is right, but it
    // points at the other record. When id-first finds nothing, the BINARY match
    // by name avoids both the false 0 and absorbing the other variant's events.
    return db.prepare(`
        SELECT * FROM ${historyTable}
        WHERE campaign_id = ? AND ${historyNameCol} = ? COLLATE BINARY
        ${orderClause}
    `).all(campaignId, name) as T[];
}

/**
 * Sort/search/paginate options for the campaign list getters.
 *
 * Every string here is a literal from the call site — a whitelist in
 * api/common/sorting.ts picks which one, but the user's own text only ever
 * arrives as `search.term`, which is bound as a parameter.
 */
export interface ListOptions {
    limit?: number;
    offset?: number;
    /** Literal ORDER BY fragment, e.g. `name ASC`. */
    orderBy?: string;
    search?: { term: string; fields: string[] };
    /** Literal column name plus a bound value, e.g. quests by status. */
    filter?: { column: string; value: string };
}

function buildWhere(opts: ListOptions): { clause: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (opts.search?.term) {
        const pattern = `%${opts.search.term.replace(/[%_\\]/g, (char) => `\\${char}`)}%`;
        const ors = opts.search.fields.map((field) => `${field} LIKE ? ESCAPE '\\'`);
        clauses.push(`(${ors.join(' OR ')})`);
        for (const _ of opts.search.fields) params.push(pattern);
    }
    if (opts.filter) {
        clauses.push(`${opts.filter.column} = ?`);
        params.push(opts.filter.value);
    }

    return { clause: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}

/**
 * The shared body of every campaign list getter.
 *
 * `table`, `columns`, `defaultOrderBy` and the option fragments are static
 * source literals; only search terms and filter values are bound. `groupBy`
 * exists for the bestiary, which collapses duplicate rows by name.
 */
export function listEntities<T>(
    table: string,
    columns: string,
    campaignId: number,
    defaultOrderBy: string,
    opts: ListOptions = {},
    groupBy?: string,
): T[] {
    const { clause, params } = buildWhere(opts);
    const group = groupBy ? ` GROUP BY ${groupBy}` : '';
    return db.prepare(`
        SELECT ${columns} FROM ${table}
        WHERE campaign_id = ?${clause}${group}
        ORDER BY ${opts.orderBy || defaultOrderBy}
        LIMIT ? OFFSET ?
    `).all(campaignId, ...params, opts.limit ?? 25, opts.offset ?? 0) as T[];
}

/**
 * The matching count. Must apply the same filters as listEntities, or a
 * searched list reports the unfiltered total and the pagination footer lies.
 */
export function countEntities(table: string, campaignId: number, opts: ListOptions = {}, groupBy?: string): number {
    const { clause, params } = buildWhere(opts);
    const sql = groupBy
        ? `SELECT COUNT(*) as count FROM (SELECT 1 FROM ${table} WHERE campaign_id = ?${clause} GROUP BY ${groupBy})`
        : `SELECT COUNT(*) as count FROM ${table} WHERE campaign_id = ?${clause}`;
    const row = db.prepare(sql).get(campaignId, ...params) as { count: number };
    return row.count;
}

export interface AlignmentScores {
    moralScore: number;
    ethicalScore: number;
    moralLabel: string;
    ethicalLabel: string;
}

/**
 * Recomputes the alignment scores by aggregating the event weights in the
 * entity's history table. Shared formula (alignmentUtils), identical for NPCs,
 * characters and factions — the query+aggregation block used to be duplicated
 * across the three repositories. `historyTable`/`nameColumn` are static.
 */
export function computeAlignmentFromHistory(
    campaignId: number,
    historyTable: 'npc_history' | 'character_history' | 'faction_history',
    nameColumn: 'npc_name' | 'character_name' | 'faction_name',
    name: string,
    entityId?: number | null
): AlignmentScores {
    // With entityId: id-first + name fallback for legacy rows (entity_id NULL).
    // Without it (character_history has no entity_id): by name only, as before.
    const weights = (entityId != null
        ? db.prepare(`
            SELECT moral_weight, ethical_weight
            FROM ${historyTable} WHERE campaign_id = ?
            AND (entity_id = ? OR (entity_id IS NULL AND lower(${nameColumn}) = lower(?)))
            AND (moral_weight != 0 OR ethical_weight != 0)
        `).all(campaignId, entityId, name)
        : db.prepare(`
            SELECT moral_weight, ethical_weight
            FROM ${historyTable} WHERE campaign_id = ? AND lower(${nameColumn}) = lower(?)
            AND (moral_weight != 0 OR ethical_weight != 0)
        `).all(campaignId, name)) as { moral_weight: number; ethical_weight: number }[];

    const moralScore = computeAggregatedAlignmentScore(weights.map(w => w.moral_weight));
    const ethicalScore = computeAggregatedAlignmentScore(weights.map(w => w.ethical_weight));

    return {
        moralScore,
        ethicalScore,
        moralLabel: getMoralAlignment(moralScore),
        ethicalLabel: getEthicalAlignment(ethicalScore)
    };
}

/** The three history tables that carry moral_weight/ethical_weight. */
export type AlignmentHistoryTable = 'npc_history' | 'character_history' | 'faction_history';

export function isAlignmentHistoryTable(table: string): table is AlignmentHistoryTable {
    return table === 'npc_history' || table === 'character_history' || table === 'faction_history';
}

/**
 * Writes the aggregated alignment back onto the parent entity after its history
 * has changed.
 *
 * `addNpcEvent`/`addCharacterEvent`/`addFactionEvent` already do it inline at
 * insert time: without this helper, editing or deleting an event from the web
 * CRUD would change the weight but leave the entity with the old score, and the
 * alignment bar would contradict the very event list that produces it.
 *
 * The entity name comes from the history row, never from the user.
 */
export function recomputeAlignmentForHistory(
    campaignId: number,
    historyTable: AlignmentHistoryTable,
    name: string
): AlignmentScores | null {
    if (historyTable === 'character_history') {
        // `characters` has no entity_id on its history: aggregation by name.
        const scores = computeAlignmentFromHistory(campaignId, historyTable, 'character_name', name);
        db.prepare(`
            UPDATE characters
            SET moral_score = ?, ethical_score = ?,
                alignment_moral = ?, alignment_ethical = ?,
                rag_sync_needed = 1
            WHERE campaign_id = ? AND lower(character_name) = lower(?)
        `).run(scores.moralScore, scores.ethicalScore, scores.moralLabel, scores.ethicalLabel, campaignId, name);
        return scores;
    }

    if (historyTable === 'npc_history') {
        const entityId = resolveEntityId('npc_dossier', 'name', campaignId, name);
        const scores = computeAlignmentFromHistory(campaignId, historyTable, 'npc_name', name, entityId);
        db.prepare(`
            UPDATE npc_dossier
            SET moral_score = ?, ethical_score = ?,
                alignment_moral = ?, alignment_ethical = ?,
                last_updated = CURRENT_TIMESTAMP, rag_sync_needed = 1
            WHERE campaign_id = ? AND lower(name) = lower(?)
        `).run(scores.moralScore, scores.ethicalScore, scores.moralLabel, scores.ethicalLabel, campaignId, name);
        return scores;
    }

    const faction = db.prepare(
        `SELECT id, is_party FROM factions WHERE campaign_id = ? AND lower(name) = lower(?)`
    ).get(campaignId, name) as { id: number; is_party: number } | undefined;
    if (!faction) return null;

    const scores = computeAlignmentFromHistory(campaignId, historyTable, 'faction_name', name, faction.id);
    db.prepare(`
        UPDATE factions
        SET moral_score = ?, ethical_score = ?,
            alignment_moral = ?, alignment_ethical = ?,
            last_updated = CURRENT_TIMESTAMP, rag_sync_needed = 1
        WHERE id = ?
    `).run(scores.moralScore, scores.ethicalScore, scores.moralLabel, scores.ethicalLabel, faction.id);

    // The party faction is the group alignment shown on the campaign.
    if (faction.is_party) {
        db.prepare(`
            UPDATE campaigns
            SET party_moral_score = ?, party_ethical_score = ?,
                party_alignment_moral = ?, party_alignment_ethical = ?
            WHERE id = ?
        `).run(scores.moralScore, scores.ethicalScore, scores.moralLabel, scores.ethicalLabel, campaignId);
    }
    return scores;
}
