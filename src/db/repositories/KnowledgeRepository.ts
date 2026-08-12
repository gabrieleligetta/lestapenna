import { db } from '../client';
import { KnowledgeFragment } from '../types';

// Version counter for the fragments: bumped on every mutation that goes through the
// repository. The vector cache in bard/rag uses it to invalidate itself without short TTLs.
// (Raw mutations outside the repository — e.g. purgeSessionData — are covered by the
// cache's own safety TTL.)
let knowledgeVersion = 0;
export const getKnowledgeVersion = () => knowledgeVersion;
const bumpKnowledgeVersion = () => { knowledgeVersion++; };

/** Escapes the LIKE metacharacters (%, _, \) — ALWAYS use with `ESCAPE '\'`. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

const TIMELINE_HEADING = 'CRONOLOGIA SNAPSHOT (dal più vecchio al più recente)';
const CURRENT_STATE_HEADING = 'STATO ATTUALE';
const SNAPSHOT_START = '--- SNAPSHOT @';
const SNAPSHOT_END = '--- FINE SNAPSHOT ---';
const RAG_HEADER_SQL = `RTRIM(
    CASE
        WHEN INSTR(content, char(10)) > 0
            THEN SUBSTR(content, 1, INSTR(content, char(10)) - 1)
        ELSE content
    END,
    char(13)
)`;

/** How fragments that talk about a given entity are recognized. */
export interface EntityFragmentQuery {
    /** `session_id` marker of the dedicated card, e.g. 'DOSSIER_UPDATE'. */
    snapshotSessionId?: string;
    /** Substring of the canonical header inside `content`. */
    headerNeedle?: string;
    /** The atlas indexes its cards by columns, not by header. */
    location?: { macro: string; micro: string };
    /** Riferimento tipizzato, es. `npc:12`. */
    entityRef?: string;
    /** NPC id in the legacy untyped format. */
    legacyNpcId?: number;
    /** The name inside the `associated_npcs` JSON. */
    associatedName?: string;
}

/** Readable projection of a fragment: without the embedding, which is a BLOB. */
export interface EntityFragmentRow {
    id: number;
    session_id: string | null;
    content: string;
    created_at: number | null;
    start_timestamp: number | null;
    macro_location: string | null;
    micro_location: string | null;
    associated_npcs: string | null;
    associated_entity_ids: string | null;
}

interface RagSnapshotRow {
    id: number;
    content: string;
    created_at: number | null;
}

interface RagSnapshotVersion {
    timestamp: number;
    body: string;
}

function snapshotBody(content: string): string {
    const newline = content.indexOf('\n');
    return (newline >= 0 ? content.slice(newline + 1) : '').trim();
}

/**
 * Reads both the legacy cards (one row = one snapshot) and the consolidated
 * format. The timeline therefore stays incremental: a new sync adds a version
 * without nesting the already consolidated one inside the history.
 */
function extractSnapshotVersions(row: RagSnapshotRow): RagSnapshotVersion[] {
    const body = snapshotBody(row.content);
    const timelineAt = body.indexOf(`\n${TIMELINE_HEADING}`);
    if (timelineAt < 0) {
        return [{ timestamp: row.created_at || 0, body }];
    }

    const timeline = body.slice(timelineAt + TIMELINE_HEADING.length + 1);
    const marker = /--- SNAPSHOT @(\d+) ---\r?\n([\s\S]*?)\r?\n--- FINE SNAPSHOT ---/g;
    const versions: RagSnapshotVersion[] = [];
    let match: RegExpExecArray | null;
    while ((match = marker.exec(timeline)) !== null) {
        versions.push({
            timestamp: Number(match[1]) || 0,
            body: match[2].trim(),
        });
    }

    // Incomplete/unrecognized consolidated format: better to keep it as a
    // single version than to risk losing historical text.
    return versions.length > 0
        ? versions
        : [{ timestamp: row.created_at || 0, body }];
}

function buildSnapshotTimeline(
    officialHeader: string,
    rows: RagSnapshotRow[],
    additional?: { content: string; timestamp: number },
): string {
    const versions = rows
        .flatMap(extractSnapshotVersions);
    if (additional) {
        versions.push({
            timestamp: additional.timestamp,
            body: snapshotBody(additional.content),
        });
    }
    versions.sort((a, b) => a.timestamp - b.timestamp);

    const current = versions[versions.length - 1] ?? { timestamp: 0, body: '' };
    const timeline = versions.map((version) => [
        `${SNAPSHOT_START}${version.timestamp} ---`,
        version.body,
        SNAPSHOT_END,
    ].join('\n')).join('\n\n');

    return [
        officialHeader,
        CURRENT_STATE_HEADING,
        current.body,
        '',
        TIMELINE_HEADING,
        timeline,
    ].join('\n').trim();
}

function getEntityRagSnapshotRows(
    campaignId: number,
    sessionId: string,
    officialHeaders: string[],
): RagSnapshotRow[] {
    if (officialHeaders.length === 0) return [];
    const predicates = officialHeaders.map(() => `${RAG_HEADER_SQL} = ? COLLATE BINARY`).join(' OR ');
    return db.prepare(`
        SELECT id, content, created_at
        FROM knowledge_fragments
        WHERE campaign_id = ?
          AND session_id = ?
          AND (${predicates})
        ORDER BY COALESCE(created_at, 0) ASC, id ASC
    `).all(campaignId, sessionId, ...officialHeaders) as RagSnapshotRow[];
}

function insertKnowledgeFragmentRow(
    campaignId: number,
    sessionId: string,
    content: string,
    embedding: number[],
    model: string,
    startTimestamp: number,
    macro: string | null,
    micro: string | null,
    npcs: string[],
    entityRefs: string[],
): void {
    const embeddingJson = JSON.stringify(embedding);
    const embeddingBlob = Buffer.from(Float32Array.from(embedding).buffer);
    const npcsJson = npcs.length > 0 ? JSON.stringify(npcs) : null;
    const entityRefsStr = entityRefs.length > 0 ? entityRefs.join(',') : null;

    db.prepare(`
        INSERT INTO knowledge_fragments (
            campaign_id, session_id, content, embedding_json, embedding, embedding_model,
            vector_dimension, start_timestamp, created_at,
            macro_location, micro_location, associated_npcs, associated_entity_ids
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        campaignId, sessionId, content, embeddingJson, embeddingBlob, model,
        embedding.length, startTimestamp, startTimestamp || Date.now(),
        macro, micro, npcsJson, entityRefsStr,
    );
}

export const knowledgeRepository = {
    insertKnowledgeFragment: (
        campaignId: number,
        sessionId: string,
        content: string,
        embedding: number[],
        model: string,
        startTimestamp: number = 0,
        macro: string | null = null,
        micro: string | null = null,
        npcs: string[] = [],
        entityRefs: string[] = [] // 🆕 Entity Refs (es. ["npc:1", "npc:2", "pc:5"])
    ) => {
        // Dual-write JSON+BLOB for this release (rollback-safe); the BLOB is the
        // primary source on read, the JSON will be dropped in a future cleanup.
        insertKnowledgeFragmentRow(
            campaignId, sessionId, content, embedding, model, startTimestamp,
            macro, micro, npcs, entityRefs,
        );
        bumpKnowledgeVersion();
    },

    /**
     * Builds a self-contained authoritative card: current state on top and every
     * previous version in chronological order in the same fragment.
     * Must be called before embedding, so the vector represents the text that is
     * actually persisted.
     */
    prepareEntityRagSnapshotContent: (
        campaignId: number,
        sessionId: string,
        officialHeader: string,
        content: string,
        timestamp: number = Date.now(),
    ): string => buildSnapshotTimeline(
        officialHeader,
        getEntityRagSnapshotRows(campaignId, sessionId, [officialHeader]),
        { content, timestamp },
    ),

    /**
     * Atomically replaces the old rows with the already consolidated card.
     * The embedding is computed by the caller beforehand; delete+insert share one
     * transaction, so a failure never leaves the entity without a card.
     */
    replaceEntityRagSnapshot: (
        campaignId: number,
        sessionId: string,
        officialHeader: string,
        content: string,
        embedding: number[],
        model: string,
        startTimestamp: number = 0,
        macro: string | null = null,
        micro: string | null = null,
        npcs: string[] = [],
        entityRefs: string[] = [],
    ): number => {
        let replaced = 0;
        db.transaction(() => {
            replaced = db.prepare(`
                DELETE FROM knowledge_fragments
                WHERE campaign_id = ?
                  AND session_id = ?
                  AND ${RAG_HEADER_SQL} = ? COLLATE BINARY
            `).run(campaignId, sessionId, officialHeader).changes;
            insertKnowledgeFragmentRow(
                campaignId, sessionId, content, embedding, model, startTimestamp,
                macro, micro, npcs, entityRefs,
            );
        })();
        bumpKnowledgeVersion();
        return replaced;
    },

    /**
     * Consolidates the existing rows in place: a single RAG result keeps both
     * current state and full timeline. Keeps the embedding and metadata of the most
     * recent row; the next dirty-sync will regenerate the vector over the merged text.
     */
    consolidateEntityRagSnapshots: (
        campaignId: number,
        sessionId: string,
        officialHeader: string,
    ): number => {
        const rows = getEntityRagSnapshotRows(
            campaignId,
            sessionId,
            [officialHeader],
        );
        if (rows.length <= 1) return 0;

        const keeper = rows[rows.length - 1];
        const content = buildSnapshotTimeline(officialHeader, rows);
        const remove = db.prepare('DELETE FROM knowledge_fragments WHERE id = ?');
        db.transaction(() => {
            db.prepare('UPDATE knowledge_fragments SET content = ? WHERE id = ?')
                .run(content, keeper.id);
            for (const row of rows.slice(0, -1)) remove.run(row.id);
        })();
        bumpKnowledgeVersion();
        return rows.length - 1;
    },

    /**
     * Merges the cards of two entities during an N→1 merge. The loser's headers
     * disappear, but their content stays in the survivor's timeline.
     */
    mergeEntityRagSnapshots: (
        campaignId: number,
        sessionId: string,
        sourceHeader: string,
        targetHeader: string,
    ): number => {
        const rows = getEntityRagSnapshotRows(
            campaignId,
            sessionId,
            sourceHeader === targetHeader
                ? [targetHeader]
                : [sourceHeader, targetHeader],
        );
        if (rows.length === 0) return 0;

        const keeper = rows[rows.length - 1];
        const content = buildSnapshotTimeline(targetHeader, rows);
        const remove = db.prepare('DELETE FROM knowledge_fragments WHERE id = ?');
        db.transaction(() => {
            db.prepare('UPDATE knowledge_fragments SET content = ? WHERE id = ?')
                .run(content, keeper.id);
            for (const row of rows) {
                if (row.id !== keeper.id) remove.run(row.id);
            }
        })();
        bumpKnowledgeVersion();
        return Math.max(0, rows.length - 1);
    },

    getKnowledgeVersion,

    /**
     * The memory fragments linked to a single entity.
     *
     * An entity can be referenced in four different ways, accumulated over
     * time: its dedicated card (`session_id = '<FAMILY>_UPDATE'` + canonical
     * header), a typed reference in `associated_entity_ids` (`npc:12`), the
     * legacy NPC id in `associated_npc_ids`, and the name inside the
     * `associated_npcs` JSON. Looking for only one of them would show partial
     * memory to the very person who is cleaning it up.
     *
     * Reference comparisons are token-based — `,npc:12,` inside the
     * comma-wrapped list — otherwise `npc:1` would match `npc:12`.
     */
    listEntityFragments: (campaignId: number, query: EntityFragmentQuery): EntityFragmentRow[] => {
        const clauses: string[] = [];
        const params: unknown[] = [campaignId];

        if (query.headerNeedle) {
            // Without snapshotSessionId the match spans the whole corpus: the
            // timeline needs that, since its events land in the fragment of the
            // session where they were narrated, not in a dedicated card.
            if (query.snapshotSessionId) {
                clauses.push(`(session_id = ? AND INSTR(content, ?) > 0)`);
                params.push(query.snapshotSessionId, query.headerNeedle);
            } else {
                clauses.push(`INSTR(content, ?) > 0`);
                params.push(query.headerNeedle);
            }
        }
        if (query.snapshotSessionId && query.location) {
            clauses.push(`(session_id = ? AND lower(macro_location) = lower(?) AND lower(micro_location) = lower(?))`);
            params.push(query.snapshotSessionId, query.location.macro, query.location.micro);
        }
        if (query.entityRef) {
            clauses.push(
                `INSTR(',' || REPLACE(COALESCE(associated_entity_ids, ''), ' ', '') || ',', ?) > 0`,
            );
            params.push(`,${query.entityRef},`);
        }
        if (query.legacyNpcId != null) {
            clauses.push(`INSTR(',' || REPLACE(COALESCE(associated_npc_ids, ''), ' ', '') || ',', ?) > 0`);
            params.push(`,${query.legacyNpcId},`);
        }
        if (query.associatedName) {
            // json_each blows up on non-JSON text: the legacy rows stay
            // reachable through the other criteria anyway.
            clauses.push(`(json_valid(associated_npcs) AND EXISTS (
                SELECT 1 FROM json_each(associated_npcs) WHERE json_each.value = ?
            ))`);
            params.push(query.associatedName);
        }

        if (clauses.length === 0) return [];

        return db.prepare(`
            SELECT id, session_id, content, created_at, start_timestamp,
                   macro_location, micro_location, associated_npcs, associated_entity_ids
            FROM knowledge_fragments
            WHERE campaign_id = ? AND (${clauses.join(' OR ')})
            ORDER BY COALESCE(created_at, start_timestamp, 0) DESC, id DESC
        `).all(...params) as EntityFragmentRow[];
    },

    getEntityFragment: (campaignId: number, fragmentId: number): EntityFragmentRow | null => {
        return (db.prepare(`
            SELECT id, session_id, content, created_at, start_timestamp,
                   macro_location, micro_location, associated_npcs, associated_entity_ids
            FROM knowledge_fragments
            WHERE campaign_id = ? AND id = ?
        `).get(campaignId, fragmentId) as EntityFragmentRow | undefined) ?? null;
    },

    /** Deletes a single fragment. Bound to the campaign: the id alone is global. */
    deleteFragment: (campaignId: number, fragmentId: number): boolean => {
        const result = db.prepare(
            'DELETE FROM knowledge_fragments WHERE campaign_id = ? AND id = ?',
        ).run(campaignId, fragmentId);
        if (result.changes > 0) bumpKnowledgeVersion();
        return result.changes > 0;
    },

    /**
     * Removes a typed reference (`npc:12`) from the fragments that remain.
     *
     * Needed after deleting an entity: a session's narrative fragment stays
     * valid — that scene happened regardless — but continuing to point at a
     * non-existent id would make the ref resolve to nothing in RAG search.
     */
    removeEntityRagRefs: (campaignId: number, entityRef: string): number => {
        const rows = db.prepare(`
            SELECT id, associated_entity_ids
            FROM knowledge_fragments
            WHERE campaign_id = ? AND INSTR(COALESCE(associated_entity_ids, ''), ?) > 0
        `).all(campaignId, entityRef) as Array<{ id: number; associated_entity_ids: string | null }>;

        let stripped = 0;
        const update = db.prepare(
            'UPDATE knowledge_fragments SET associated_entity_ids = ? WHERE id = ?',
        );
        db.transaction(() => {
            for (const row of rows) {
                const refs = (row.associated_entity_ids ?? '')
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean);
                if (!refs.includes(entityRef)) continue;
                const next = refs.filter((value) => value !== entityRef).join(',');
                update.run(next || null, row.id);
                stripped++;
            }
        })();
        if (stripped > 0) bumpKnowledgeVersion();
        return stripped;
    },

    getKnowledgeFragments: (campaignId: number, model: string): KnowledgeFragment[] => {
        // ORDER BY id: insertion order coincides with the order of the session's
        // chunks — search relies on it to expand to genuinely adjacent chunks.
        return db.prepare(`
            SELECT * FROM knowledge_fragments
            WHERE campaign_id = ? AND embedding_model = ?
            ORDER BY id ASC
        `).all(campaignId, model) as KnowledgeFragment[];
    },

    /**
     * Everything a reindex towards `model` still has to convert.
     *
     * Asking «what is not on the new model» rather than «what is on the old
     * model» is what makes a half-finished pass recoverable: after a partial
     * success the campaign is already pinned to the new model, and the question
     * about the old model would find nothing left to do while the fragments
     * left behind are still there, invisible to search. It also covers the case
     * where several failed passes scattered them across different models.
     */
    getFragmentsNotOnModel: (campaignId: number, model: string): KnowledgeFragment[] => {
        return db.prepare(`
            SELECT * FROM knowledge_fragments
            WHERE campaign_id = ? AND embedding_model <> ?
            ORDER BY id ASC
        `).all(campaignId, model) as KnowledgeFragment[];
    },

    /**
     * Every chunk of ONE session, in order — to rebuild the full text (e.g.
     * "what happened in the last session?"), where top-K by semantic
     * similarity only takes the chunks most similar to the question and can
     * skip important parts (e.g. the start or the end of the session).
     */
    getFragmentsBySessionId: (sessionId: string): KnowledgeFragment[] => {
        return db.prepare(`
            SELECT * FROM knowledge_fragments
            WHERE session_id = ?
            ORDER BY id ASC
        `).all(sessionId) as KnowledgeFragment[];
    },

    deleteSessionKnowledge: (sessionId: string, model: string) => {
        db.prepare('DELETE FROM knowledge_fragments WHERE session_id = ? AND embedding_model = ?').run(sessionId, model);
        bumpKnowledgeVersion();
    },

    /**
     * Atomically replace session knowledge: delete old fragments, then insert new ones.
     * Prevents orphan/duplicate fragments on crash.
     */
    /**
     * Replaces a campaign's vectors when moving to another model.
     *
     * In a single transaction, and **only after** all the new vectors have been
     * computed: writing row by row during the recomputation would leave the
     * campaign with half its memory in one vector space and half in the other,
     * that is, with meaningless similarity scores.
     */
    applyReindexedVectors: (
        campaignId: number,
        newModel: string,
        dimension: number,
        vectors: Array<{ id: number; vector: number[] }>,
    ) => {
        const tx = db.transaction(() => {
            const update = db.prepare(`
                UPDATE knowledge_fragments
                SET embedding_json = ?, embedding = ?, embedding_model = ?, vector_dimension = ?
                WHERE id = ? AND campaign_id = ?
            `);
            for (const { id, vector } of vectors) {
                update.run(
                    JSON.stringify(vector),
                    Buffer.from(Float32Array.from(vector).buffer),
                    newModel,
                    dimension,
                    id,
                    campaignId,
                );
            }
            // The fragments not recomputed stay where they were, on the model
            // old ones: invisible to search but not lost, and recoverable
            // with a second pass. Deleting them would throw away memory for
            // un errore di rete.
        });
        tx();
        bumpKnowledgeVersion();
    },

    replaceSessionKnowledge: (
        sessionId: string,
        model: string,
        fragments: Array<{
            campaignId: number;
            content: string;
            embedding: number[];
            startTimestamp: number;
            macro: string | null;
            micro: string | null;
            npcs: string[];
            entityRefs: string[];
        }>
    ) => {
        const tx = db.transaction(() => {
            db.prepare('DELETE FROM knowledge_fragments WHERE session_id = ? AND embedding_model = ?').run(sessionId, model);

            const insertStmt = db.prepare(`
                INSERT INTO knowledge_fragments (
                    campaign_id, session_id, content, embedding_json, embedding, embedding_model,
                    vector_dimension, start_timestamp, created_at,
                    macro_location, micro_location, associated_npcs, associated_entity_ids
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            for (const f of fragments) {
                const embeddingJson = JSON.stringify(f.embedding);
                const embeddingBlob = Buffer.from(Float32Array.from(f.embedding).buffer);
                const npcsJson = f.npcs.length > 0 ? JSON.stringify(f.npcs) : null;
                const entityRefsStr = f.entityRefs.length > 0 ? f.entityRefs.join(',') : null;

                insertStmt.run(
                    f.campaignId, sessionId, f.content, embeddingJson, embeddingBlob, model,
                    f.embedding.length, f.startTimestamp, f.startTimestamp || Date.now(),
                    f.macro, f.micro, npcsJson, entityRefsStr
                );
            }
        });

        tx();
        bumpKnowledgeVersion();
    },

    migrateKnowledgeFragments: (campaignId: number, oldName: string, newName: string) => {
        // Find fragments that mention oldName in `associated_npcs` (JSON)
        // Using LIKE is an approximation, so we filter in JS
        const rows = db.prepare(`
            SELECT id, associated_npcs FROM knowledge_fragments
            WHERE campaign_id = ? AND associated_npcs LIKE ? ESCAPE '\\'
        `).all(campaignId, `%${escapeLike(oldName)}%`) as { id: number, associated_npcs: string }[];

        db.transaction(() => {
            for (const row of rows) {
                try {
                    let npcs = JSON.parse(row.associated_npcs);
                    if (Array.isArray(npcs) && npcs.includes(oldName)) {
                        npcs = npcs.map((n: string) => n === oldName ? newName : n);
                        // Deduplicate (in case newName already existed)
                        npcs = Array.from(new Set(npcs));

                        db.prepare('UPDATE knowledge_fragments SET associated_npcs = ? WHERE id = ?')
                            .run(JSON.stringify(npcs), row.id);
                    }
                } catch (e) {
                    console.error(`[Knowledge] Failed to migrate fragment ${row.id}`, e);
                }
            }
        })();
    },

    migrateRagNpcReferences: (campaignId: number, oldNpcId: number, newNpcId: number): number => {
        // Search both the new format (npc:ID) and the old one (numeric ID)
        const oldRef = `npc:${oldNpcId}`;
        const newRef = `npc:${newNpcId}`; // Hardcoded logic for createEntityRef to avoid circular dependency loop if imported

        // Parameterized LIKE (never interpolate SQL) — it is only a coarse shortlist
        // ('%12%' also matches 112): the exact match happens below, token by token.
        const fragments = db.prepare(`
            SELECT id, associated_npc_ids, associated_entity_ids FROM knowledge_fragments
            WHERE campaign_id = ? AND (
                associated_entity_ids LIKE ? OR
                associated_npc_ids LIKE ?
            )
        `).all(campaignId, `%${oldRef}%`, `%${oldNpcId}%`) as { id: number; associated_npc_ids: string | null; associated_entity_ids: string | null }[];

        let migrated = 0;
        const updateStmt = db.prepare(`UPDATE knowledge_fragments SET associated_npc_ids = ?, associated_entity_ids = ? WHERE id = ?`);

        for (const f of fragments) {
            let updatedEntityIds = f.associated_entity_ids;
            let updatedNpcIds = f.associated_npc_ids;

            // Update the entity refs (new format)
            if (f.associated_entity_ids) {
                updatedEntityIds = f.associated_entity_ids
                    .split(',')
                    .map(ref => ref.trim() === oldRef ? newRef : ref.trim())
                    .filter((v, i, a) => a.indexOf(v) === i) // Rimuovi duplicati
                    .join(',');
            }

            // Update the legacy npc_ids (backwards compatibility)
            if (f.associated_npc_ids) {
                const ids = f.associated_npc_ids.split(',').map(id => parseInt(id.trim()));
                const updatedIds = ids.map(id => id === oldNpcId ? newNpcId : id);
                const uniqueIds = Array.from(new Set(updatedIds));
                updatedNpcIds = uniqueIds.join(',');
            }

            // Write (and count) only the fragments that really changed
            if (updatedEntityIds !== f.associated_entity_ids || updatedNpcIds !== f.associated_npc_ids) {
                updateStmt.run(updatedNpcIds, updatedEntityIds, f.id);
                migrated++;
            }
        }

        if (migrated > 0) bumpKnowledgeVersion();
        console.log(`[RAG] 🔄 Migrati ${migrated} frammenti da NPC #${oldNpcId} (${oldRef}) a #${newNpcId} (${newRef})`);
        return migrated;
    },

    // NOTE on deletes by name: the match on the canonical header "[[SCHEDA ...: <name>]]"
    // is case-SENSITIVE via INSTR (SQLite LIKE is case-insensitive for ASCII, so a
    // LIKE '%: Corona di Spine]]%' would ALSO delete the survivor's "Corona di spine"
    // cards — a real bug on case-variant merges). INSTR treats %/_ as literals
    // (no escapeLike) and is case-sensitive. Anchoring to ": <name>]]" avoids hitting
    // cards that merely mention the name in the body (e.g. "Anello" inside the card of
    // "Anello del Re").
    deleteNpcRagSummary: (campaignId: number, npcName: string) => {
        // Match on the canonical header, as for the other cards. Searching the raw
        // name in associated_npcs could also remove "Anna" when merging "Ann".
        db.prepare(`
            DELETE FROM knowledge_fragments
            WHERE campaign_id = ?
            AND session_id = 'DOSSIER_UPDATE'
            AND INSTR(content, ?) > 0
        `).run(campaignId, `[[SCHEDA UFFICIALE: ${npcName}]]`);
        bumpKnowledgeVersion();
    },

    deleteAtlasRagSummary: (campaignId: number, macro: string, micro: string) => {
        // Delete previous RAG summary for this Location
        // Identify by session_id='ATLAS_UPDATE' and location fields
        db.prepare(`
            DELETE FROM knowledge_fragments
            WHERE campaign_id = ?
            AND session_id = 'ATLAS_UPDATE'
            AND macro_location = ?
            AND micro_location = ?
        `).run(campaignId, macro, micro);
        bumpKnowledgeVersion();
    },

    deleteQuestRagSummary: (campaignId: number, title: string) => {
        db.prepare(`
            DELETE FROM knowledge_fragments
            WHERE campaign_id = ? AND session_id = 'QUEST_UPDATE' AND INSTR(content, ?) > 0
        `).run(campaignId, `: ${title}]]`);
        bumpKnowledgeVersion();
    },

    deleteInventoryRagSummary: (campaignId: number, itemName: string) => {
        db.prepare(`
            DELETE FROM knowledge_fragments
            WHERE campaign_id = ? AND session_id = 'INVENTORY_UPDATE' AND INSTR(content, ?) > 0
        `).run(campaignId, `: ${itemName}]]`);
        bumpKnowledgeVersion();
    },

    deleteBestiaryRagSummary: (campaignId: number, monsterName: string) => {
        db.prepare(`
            DELETE FROM knowledge_fragments
            WHERE campaign_id = ? AND session_id = 'BESTIARY_UPDATE' AND INSTR(content, ?) > 0
        `).run(campaignId, `: ${monsterName}]]`);
        bumpKnowledgeVersion();
    },

    // --- ARTIFACTS: RAG cleanup on merge ---
    // Unlike NPCs (which have migrateKnowledgeFragments + migrateRagNpcReferences
    // + deleteNpcRagSummary), artifacts had no cleanup path at all: a merge left the
    // [[SCHEDA ARTEFATTO UFFICIALE: <oldName>]] card in knowledge_fragments
    // and the entity vector cache (semantic.ts) kept a stale vector of the loser.
    // These two methods close the gap, mirroring deleteQuestRagSummary +
    // deleteInventoryRagSummary in how they match the canonical header.

    deleteArtifactRagSummary: (campaignId: number, artifactName: string) => {
        db.prepare(`
            DELETE FROM knowledge_fragments
            WHERE campaign_id = ? AND session_id = 'ARTIFACT_UPDATE' AND INSTR(content, ?) > 0
        `).run(campaignId, `: ${artifactName}]]`);
        bumpKnowledgeVersion();
    },

    /** Deletes only the official card of the absorbed faction. */
    deleteFactionRagSummary: (campaignId: number, factionName: string): number => {
        const result = db.prepare(`
            DELETE FROM knowledge_fragments
            WHERE campaign_id = ?
              AND session_id = 'FACTION_UPDATE'
              AND INSTR(content, ?) > 0
        `).run(campaignId, `[[SCHEDA FAZIONE UFFICIALE: ${factionName}]]`);
        if (result.changes > 0) bumpKnowledgeVersion();
        return result.changes;
    },

    /**
     * Repoints a typed entity-id reference (e.g. faction:12 → faction:13)
     * token by token, without the false 12/112 match.
     */
    rewriteTypedEntityRagRefs: (
        campaignId: number,
        entityType: string,
        oldId: number,
        newId: number,
    ): number => {
        const oldRef = `${entityType}:${oldId}`;
        const newRef = `${entityType}:${newId}`;
        const rows = db.prepare(`
            SELECT id, associated_entity_ids
            FROM knowledge_fragments
            WHERE campaign_id = ? AND INSTR(COALESCE(associated_entity_ids, ''), ?) > 0
        `).all(campaignId, oldRef) as Array<{ id: number; associated_entity_ids: string | null }>;

        let rewritten = 0;
        const update = db.prepare(
            'UPDATE knowledge_fragments SET associated_entity_ids = ? WHERE id = ?',
        );
        db.transaction(() => {
            for (const row of rows) {
                const refs = (row.associated_entity_ids ?? '')
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean);
                if (!refs.includes(oldRef)) continue;
                const next = Array.from(new Set(
                    refs.map((value) => value === oldRef ? newRef : value),
                )).join(',');
                update.run(next || null, row.id);
                rewritten++;
            }
        })();
        if (rewritten > 0) bumpKnowledgeVersion();
        return rewritten;
    },

    /**
     * FACTION_UPDATE cards store the canonical name in associated_npcs.
     * Parsing the JSON avoids partial substitutions between similar names.
     */
    rewriteFactionRagAssociatedRefs: (
        campaignId: number,
        oldName: string,
        newName: string,
    ): number => {
        const rows = db.prepare(`
            SELECT id, associated_npcs
            FROM knowledge_fragments
            WHERE campaign_id = ? AND INSTR(COALESCE(associated_npcs, ''), ?) > 0
        `).all(campaignId, oldName) as Array<{ id: number; associated_npcs: string | null }>;

        let rewritten = 0;
        const update = db.prepare(
            'UPDATE knowledge_fragments SET associated_npcs = ? WHERE id = ?',
        );
        db.transaction(() => {
            for (const row of rows) {
                try {
                    const names = JSON.parse(row.associated_npcs ?? '[]');
                    if (!Array.isArray(names) || !names.includes(oldName)) continue;
                    const next = Array.from(new Set(
                        names.map((value: unknown) => value === oldName ? newName : value),
                    ));
                    update.run(JSON.stringify(next), row.id);
                    rewritten++;
                } catch {
                    // Legacy non-JSON data: do not risk a partial substitution.
                }
            }
        })();
        if (rewritten > 0) bumpKnowledgeVersion();
        return rewritten;
    },

    /**
     * Rewrites the `Vedi [[SCHEDA ARTEFATTO UFFICIALE: <oldName>]]` references inside
     * INVENTORY_UPDATE fragments (inventory cards link the artifact by name).
     * Without this, a renamed/absorbed artifact leaves dangling references in the
     * inventory cards. Exact match on the full header string (REPLACE), with an
     * escaped LIKE shortlist to avoid scanning the whole table.
     * Returns the number of fragments actually modified.
     */
    rewriteArtifactRagNameRefs: (campaignId: number, oldName: string, newName: string): number => {
        const oldHeader = `[[SCHEDA ARTEFATTO UFFICIALE: ${oldName}]]`;
        const newHeader = `[[SCHEDA ARTEFATTO UFFICIALE: ${newName}]]`;
        // Shortlist via case-sensitive INSTR on the exact header (avoids loading
        // every fragment; REPLACE is case-sensitive anyway, but INSTR already filters
        // to refs of the exact name — no over-match on case variants).
        const rows = db.prepare(`
            SELECT id FROM knowledge_fragments
            WHERE campaign_id = ?
              AND session_id = 'INVENTORY_UPDATE'
              AND INSTR(content, ?) > 0
        `).all(campaignId, oldHeader) as { id: number }[];

        let rewritten = 0;
        if (rows.length === 0) return 0;

        const updateStmt = db.prepare(`UPDATE knowledge_fragments SET content = REPLACE(content, ?, ?) WHERE id = ?`);
        db.transaction(() => {
            for (const row of rows) {
                const res = updateStmt.run(oldHeader, newHeader, row.id);
                if (res.changes > 0) rewritten++;
            }
        })();

        if (rewritten > 0) bumpKnowledgeVersion();
        console.log(`[RAG] 🔄 Riscritti ${rewritten} ref inventario artefatto "${oldName}" -> "${newName}"`);
        return rewritten;
    },

    /**
     * Rewrites the header of an entity's OFFICIAL card (old name → new)
     * inside the *_UPDATE fragments, in place (case-sensitive REPLACE over an INSTR
     * shortlist). Used by the survivor rename after a merge whose `final_name`
     * differs from the current name, and reused by the migration when needed.
     * Returns the number of fragments modified.
     */
    rewriteEntityRagHeader: (campaignId: number, fragmentType: string, oldHeader: string, newHeader: string): number => {
        const rows = db.prepare(`
            SELECT id FROM knowledge_fragments
            WHERE campaign_id = ?
              AND session_id = ?
              AND INSTR(content, ?) > 0
        `).all(campaignId, fragmentType, oldHeader) as { id: number }[];

        if (rows.length === 0) return 0;
        let rewritten = 0;
        const updateStmt = db.prepare(`UPDATE knowledge_fragments SET content = REPLACE(content, ?, ?) WHERE id = ?`);
        db.transaction(() => {
            for (const row of rows) {
                const res = updateStmt.run(oldHeader, newHeader, row.id);
                if (res.changes > 0) rewritten++;
            }
        })();
        if (rewritten > 0) bumpKnowledgeVersion();
        return rewritten;
    },

    /**
     * Rewrites the associated_npcs column (NPC rename): case-sensitive REPLACE of the
     * old name → new one on the fragments that mention it. Used by the survivor rename
     * after an NPC merge with `final_name`. NOTE: REPLACE substitutes every occurrence;
     * if one name is a substring of another NPC in the same list, edge cases occur
     * (acceptable for renames of canonical names).
     */
    rewriteNpcRagAssociatedRefs: (campaignId: number, oldName: string, newName: string): number => {
        const res = db.prepare(`
            UPDATE knowledge_fragments
            SET associated_npcs = REPLACE(associated_npcs, ?, ?)
            WHERE campaign_id = ? AND INSTR(associated_npcs, ?) > 0
        `).run(oldName, newName, campaignId, oldName);
        if (res.changes > 0) bumpKnowledgeVersion();
        return res.changes;
    }
};
