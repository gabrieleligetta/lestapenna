import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { db } from '../../../db/client';
import { knowledgeRepository } from '../../../db/repositories/KnowledgeRepository';
import { buildEntityIndex, localMatch, normalizeForIndex } from '../../../bard/reconciliation/entityIndex';
import { getEntityVectors, parseSchedaName, SEMANTIC_THRESHOLD } from '../../../bard/reconciliation/semantic';
import { cosineSimilarity } from '../../../bard/helpers';
import {
    MERGE_ENTITY_SPECS,
    type MergeEntity,
    type MergeEntitySpec,
} from './merge-entity.registry';
import {
    MergeableEntityType,
    DuplicateClusterDto,
    DuplicateMemberDto,
    DuplicatesResultDto,
    MergeReportDto,
    MergeResultDto,
    MergePreviewDto,
    RecordFieldDiffDto,
    HistoryEventDto,
    RagFragmentDto,
    RelationImpactDto,
    RenamePreviewDto,
} from '../dto/merge.dto';

const MAX_DROPS = 20;
const RAG_HEADER_SQL = `RTRIM(
    CASE
        WHEN INSTR(content, char(10)) > 0
            THEN SUBSTR(content, 1, INSTR(content, char(10)) - 1)
        ELSE content
    END,
    char(13)
)`;

function ragSnapshotVersionCount(content: string): number {
    return Math.max(1, content.match(/--- SNAPSHOT @\d+ ---/g)?.length ?? 0);
}

/** Union-find minimal su id numerici. */
class UnionFind {
    private parent = new Map<number, number>();
    find(x: number): number {
        if (!this.parent.has(x)) this.parent.set(x, x);
        let root = x;
        while (this.parent.get(root)! !== root) root = this.parent.get(root)!;
        let cur = x;
        while (this.parent.get(cur)! !== root) {
            const next = this.parent.get(cur)!;
            this.parent.set(cur, root);
            cur = next;
        }
        return root;
    }
    union(a: number, b: number): void {
        const ra = this.find(a), rb = this.find(b);
        if (ra !== rb) this.parent.set(ra, rb);
    }
}

@Injectable()
export class MergeService {
    // --- DUPLICATE DETECTION ---

    async findDuplicates(
        campaignId: number,
        entityType: MergeableEntityType,
        semantic: boolean,
    ): Promise<DuplicatesResultDto> {
        const spec = MERGE_ENTITY_SPECS[entityType];
        const raw = spec.list(campaignId);
        if (raw.length < 2) return { clusters: [] };

        const uf = new UnionFind();
        // edge list, to remember the score and reason of the best match between two entities
        const bestEdge = new Map<string, { score: number; reason: string }>();
        const edgeKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
        const recordEdge = (a: number, b: number, score: number, reason: string) => {
            if (score < 0.5) return;
            const k = edgeKey(a, b);
            const prev = bestEdge.get(k);
            if (!prev || score > prev.score) bestEdge.set(k, { score, reason });
            uf.union(a, b);
        };

        // Pass 1 — cluster per nome normalizzato (case/accenti/articoli): cattura i dup
        // "Corona di spine" / "Corona di Spine", which the BINARY UNIQUE let through.
        const byNorm = new Map<string, MergeEntity[]>();
        for (const e of raw) {
            const n = normalizeForIndex(e.name);
            if (!byNorm.has(n)) byNorm.set(n, []);
            byNorm.get(n)!.push(e);
        }
        for (const group of byNorm.values()) {
            if (group.length < 2) continue;
            for (let i = 1; i < group.length; i++) {
                recordEdge(group[0].id, group[i].id, 1.0, 'exact_normalized_match');
            }
        }

        // Pass 2 — fuzzy via the reconciliation index (trigram + Levenshtein).
        // Note: buildEntityIndex dedupes by normalized name, so exact variants
        // are already caught in Pass 1; Pass 2 is for near-dups ("Anello Farfalla").
        const index = buildEntityIndex(campaignId);
        for (const e of raw) {
            const cands = localMatch(index, e.name, spec.reconciliationType, {
                description: typeof e.description === 'string' ? e.description : undefined,
            });
            for (const c of cands) {
                if (c.entity.id === e.id) continue;
                if (!raw.some((r) => r.id === c.entity.id)) continue; // safety: only entities from the list
                recordEdge(e.id, c.entity.id, c.score, c.reason);
            }
        }

        // Pass 3 (optional, ?semantic=1) — semantic shortlist over the cached RAG vectors.
        // It reuses the already stored embeddings (no LLM call, no new embedding):
        // pairwise cosine between the *_UPDATE cards; above the threshold → a cluster.
        if (semantic) {
            const vectors = getEntityVectors(campaignId, spec.fragmentType, parseSchedaName);
            const byNameLower = new Map<string, MergeEntity>();
            for (const e of raw) byNameLower.set(e.name.toLowerCase(), e);
            for (let i = 0; i < vectors.length; i++) {
                for (let j = i + 1; j < vectors.length; j++) {
                    const sim = cosineSimilarity(vectors[i].vector, vectors[j].vector);
                    if (sim < SEMANTIC_THRESHOLD) continue;
                    const a = byNameLower.get(vectors[i].key.toLowerCase());
                    const b = byNameLower.get(vectors[j].key.toLowerCase());
                    if (!a || !b || a.id === b.id) continue;
                    recordEdge(a.id, b.id, sim, 'semantic_embedding');
                }
            }
        }

        // Collecting the clusters (connected components with 2 or more members).
        const groups = new Map<number, MergeEntity[]>();
        for (const e of raw) {
            const root = uf.find(e.id);
            if (!groups.has(root)) groups.set(root, []);
            groups.get(root)!.push(e);
        }

        const ragPresence = this.computeRagPresence(campaignId, spec.fragmentType);
        const clusters: DuplicateClusterDto[] = [];
        for (const group of groups.values()) {
            if (group.length < 2) continue;
            const members = group.map((e) => this.toMember(e, raw, bestEdge, edgeKey, spec, campaignId, ragPresence));
            const survivor = this.pickSurvivor(members);
            // Reorder: survivor first, then by descending score.
            members.sort((a, b) => (a.short_id === survivor ? -1 : b.short_id === survivor ? 1 : b.score - a.score));
            clusters.push({
                id: group.map((e) => e.short_id || String(e.id)).sort().join('+'),
                members,
                suggested_survivor: survivor,
            });
        }
        // Larger / more confident clusters first.
        clusters.sort((a, b) => b.members.length - a.members.length || b.members[0].score - a.members[0].score);
        return { clusters };
    }

    // --- MEMBERS: details for entities selected manually by the user ---
    // No detection: the user selects the entities from the list (checkbox) and
    // calls this endpoint to get their details (history, RAG, manual) to
    // show in the merge modal.

    async getMembers(
        campaignId: number,
        entityType: MergeableEntityType,
        shortIds: string[],
    ): Promise<DuplicateMemberDto[]> {
        this.validateIdList(shortIds, 'short_ids', 2, MAX_DROPS + 1);
        const spec = MERGE_ENTITY_SPECS[entityType];
        const ragPresence = this.computeRagPresence(campaignId, spec.fragmentType);
        const entities: Array<{ shortId: string; entity: MergeEntity }> = [];
        for (const sid of shortIds) {
            const e = spec.getByShortId(campaignId, sid);
            if (!e) throw new NotFoundException(`Entity ${sid} not found`);
            entities.push({ shortId: sid, entity: e });
        }
        const selectionError = spec.validateSelection?.(
            entities[0].entity,
            entities.slice(1).map(({ entity }) => entity),
        );
        if (selectionError) throw new BadRequestException(selectionError);

        const members: DuplicateMemberDto[] = [];
        for (const { shortId: sid, entity: e } of entities) {
            members.push({
                short_id: sid,
                name: e.name,
                is_manual: e.is_manual ? 1 : 0,
                history_count: spec.history(campaignId, e.name).length,
                has_rag: ragPresence.has(e.name.toLowerCase()),
                description: typeof e.description === 'string' ? e.description : null,
                score: 0,
                reason: 'manual_selection',
            });
        }
        return members;
    }

    // --- MERGE N→1 ---

    async mergeEntities(
        campaignId: number,
        entityType: MergeableEntityType,
        keepShortId: string,
        dropShortIds: string[],
        opts: { description?: string; autoMergeDescription?: boolean; confirmManualMerge?: boolean; finalName?: string },
    ): Promise<MergeResultDto> {
        const spec = MERGE_ENTITY_SPECS[entityType];
        const selection = this.resolveSelection(campaignId, spec, keepShortId, dropShortIds);
        const keepName = selection.survivor.name;
        const finalName = opts.finalName?.trim() || keepName;
        if (finalName.length > 200) throw new BadRequestException('final_name must be at most 200 characters');

        // Full preflight before any write: manual permissions, name collisions
        // and the presence of every record. Avoids predictable partial merges.
        for (const { entity: drop } of selection.drops) {
            if (drop.is_manual === 1 && !opts.confirmManualMerge) {
                throw new ConflictException(
                    `Drop "${drop.name}" is manual (is_manual=1). Confirm with confirm_manual_merge=true to absorb it.`,
                );
            }
        }
        const collidingName = spec.getByName(campaignId, finalName);
        const selectedEntityIds = new Set([
            selection.survivor.id,
            ...selection.drops.map(({ entity }) => entity.id),
        ]);
        if (collidingName && !selectedEntityIds.has(collidingName.id)) {
            throw new ConflictException(`Another entity already uses final_name "${finalName}"`);
        }

        const prepared = await spec.prepare(
            selection.survivor,
            selection.drops.map(({ entity }) => entity),
            opts,
        );
        const preview = this.buildPreview(
            campaignId,
            spec,
            keepShortId,
            selection.survivor,
            selection.drops,
            finalName,
            prepared.description,
        );
        const mergedRows = selection.drops.map(({ shortId, entity }) => ({ short_id: shortId, name: entity.name }));
        let shortIdRegenerated = false;
        let manualPropagated = false;
        let relationsRepointed = 0;
        let renamed: { from: string; to: string } | undefined;
        let renameHistoryRepointed = 0;
        let renameRagRefsRewritten = 0;

        // A single transaction covers all the losers, record/history, fragments
        // and the final rename. The adapters' inner transactions become savepoints.
        const survivorAfter = db.transaction(() => {
            for (const { entity: drop } of selection.drops) {
                const applied = spec.applyDrop(campaignId, drop, keepName, prepared);
                shortIdRegenerated = shortIdRegenerated || applied.shortIdRegenerated;
                manualPropagated = manualPropagated || applied.manualPropagated;
                relationsRepointed += applied.relationsRepointed;
            }

            const survivorAfterDrops = spec.getByName(campaignId, keepName);
            if (!survivorAfterDrops) throw new Error('Survivor disappeared during merge');
            knowledgeRepository.consolidateEntityRagSnapshots(
                campaignId,
                spec.fragmentType,
                spec.officialHeader(keepName),
            );
            if (finalName !== keepName) {
                const rn = spec.rename(campaignId, survivorAfterDrops.id, keepName, finalName);
                renameHistoryRepointed = rn.historyRepointed;
                renameRagRefsRewritten = rn.ragRefsRewritten;
                renamed = { from: keepName, to: finalName };
            }

            // Verifying the outcome must also precede the COMMIT: otherwise the
            // API could answer 500 after having already merged the data.
            const mergedSurvivor = spec.getByName(campaignId, finalName);
            if (!mergedSurvivor) throw new Error('Survivor not found after merge');
            return mergedSurvivor;
        })();

        const consolidatedVersions = new Map<number, number>();
        for (const row of preview.rag) {
            if (row.action !== 'deleted' && row.action !== 'consolidated') continue;
            consolidatedVersions.set(
                row.fragment_id,
                Math.max(consolidatedVersions.get(row.fragment_id) ?? 0, row.version_count),
            );
        }
        const rewrittenFragmentIds = new Set(preview.rag.filter((row) => row.action === 'rewritten').map((row) => row.fragment_id));
        const report: MergeReportDto = {
            merged_rows: mergedRows,
            history_repointed: renamed ? renameHistoryRepointed : preview.events.length,
            rag_fragments_deleted: Array.from(consolidatedVersions.values())
                .reduce((total, count) => total + count, 0),
            rag_refs_rewritten: rewrittenFragmentIds.size + renameRagRefsRewritten,
            relations_repointed: relationsRepointed,
            short_id_regenerated: shortIdRegenerated,
            manual_propagated: manualPropagated,
            bio_auto_merged: prepared.bioAutoMerged || undefined,
            renamed,
        };
        return {
            survivor_short_id: survivorAfter.short_id || keepShortId,
            survivor_name: survivorAfter.name,
            report,
        };
    }

    // --- PREVIEW: diff "what is lost / what remains" before the merge ---

    async previewMerge(
        campaignId: number,
        entityType: MergeableEntityType,
        keepShortId: string,
        dropShortIds: string[],
        finalName?: string,
        description?: string,
    ): Promise<MergePreviewDto> {
        const spec = MERGE_ENTITY_SPECS[entityType];
        const selection = this.resolveSelection(campaignId, spec, keepShortId, dropShortIds);
        const survivor = selection.survivor;
        const survivorName = survivor.name;
        const finalNameNorm = (finalName?.trim() || survivorName);
        const collision = spec.getByName(campaignId, finalNameNorm);
        const selectedEntityIds = new Set([survivor.id, ...selection.drops.map(({ entity }) => entity.id)]);
        if (collision && !selectedEntityIds.has(collision.id)) {
            throw new ConflictException(`Another entity already uses final_name "${finalNameNorm}"`);
        }
        return this.buildPreview(
            campaignId,
            spec,
            keepShortId,
            survivor,
            selection.drops,
            finalNameNorm,
            description,
        );
    }

    private buildPreview(
        campaignId: number,
        spec: MergeEntitySpec,
        keepShortId: string,
        survivor: MergeEntity,
        drops: Array<{ shortId: string; entity: MergeEntity }>,
        finalNameNorm: string,
        description?: string,
    ): MergePreviewDto {
        const survivorName = survivor.name;
        const record: RecordFieldDiffDto[] = [];
        const events: HistoryEventDto[] = [];
        const relations: RelationImpactDto[] = [];
        const rag: RagFragmentDto[] = [];
        const projectedValues = new Map<string, unknown>(
            spec.fields.map(({ key }) => [key, key === 'description' && description?.trim()
                ? description.trim()
                : survivor[key]]),
        );

        for (const { shortId, entity } of drops) {
            // Simulates the adapter's policy in N→1 order: the diff matches the
            // value that is actually persisted, including fill-empty and description override.
            for (const field of spec.fields) {
                const currentVal = projectedValues.get(field.key) ?? null;
                const dropVal = entity[field.key] ?? null;
                const survivorEmpty = currentVal == null || String(currentVal).trim() === '';
                const dropEmpty = dropVal == null || String(dropVal).trim() === '';
                if (dropEmpty) continue;
                let verdict: RecordFieldDiffDto['verdict'];
                if (String(currentVal ?? '') === String(dropVal)) {
                    verdict = 'kept';
                } else if (field.policy === 'fill-empty' && survivorEmpty) {
                    projectedValues.set(field.key, dropVal);
                    verdict = 'kept';
                } else {
                    verdict = survivorEmpty ? 'discarded' : 'differs';
                }
                record.push({
                    field: field.key,
                    survivor_value: verdict === 'kept' && survivorEmpty
                        ? String(dropVal)
                        : (survivorEmpty ? null : String(currentVal)),
                    drop_short_id: shortId,
                    drop_name: entity.name,
                    drop_value: String(dropVal),
                    verdict,
                });
            }

            const hist = spec.history(campaignId, entity.name);
            for (const h of hist) {
                events.push({
                    drop_short_id: shortId,
                    drop_name: entity.name,
                    event_type: h.event_type ?? '',
                    session_date: h.timestamp ? new Date(h.timestamp).toISOString() : null,
                    description_preview: (h.description ?? '').slice(0, 140),
                });
            }

            for (const relation of spec.relations?.(campaignId, entity, survivor) ?? []) {
                relations.push({
                    drop_short_id: shortId,
                    drop_name: entity.name,
                    relation_type: relation.relationType,
                    label: relation.label,
                    action: relation.action,
                });
            }

            const header = spec.officialHeader(entity.name);
            const ragRows = db.prepare(
                `SELECT id, content FROM knowledge_fragments
                 WHERE campaign_id = ? AND session_id = ?
                   AND ${RAG_HEADER_SQL} = ? COLLATE BINARY
                 ORDER BY created_at DESC, id DESC`,
            ).all(campaignId, spec.fragmentType, header) as { id: number; content: string }[];
            for (const r of ragRows) {
                rag.push({
                    drop_short_id: shortId,
                    drop_name: entity.name,
                    fragment_id: r.id,
                    header: r.content.slice(0, 100),
                    version_count: ragSnapshotVersionCount(r.content),
                    action: 'consolidated',
                });
            }
            const deletedIds = new Set(ragRows.map((row) => row.id));
            for (const ref of spec.referenceRows(campaignId, entity, deletedIds)) {
                rag.push({
                    drop_short_id: shortId,
                    drop_name: entity.name,
                    fragment_id: ref.id,
                    header: ref.header,
                    version_count: 1,
                    action: 'rewritten',
                });
            }
        }

        // Survivor's own RAG fragments: shown as 'kept' so the user sees what
        // survives (full visibility on both records' fragments before merging).
        const survRagRows = db.prepare(
            `SELECT id, content FROM knowledge_fragments
             WHERE campaign_id = ? AND session_id = ?
               AND ${RAG_HEADER_SQL} = ? COLLATE BINARY
             ORDER BY created_at DESC, id DESC`,
        ).all(campaignId, spec.fragmentType, spec.officialHeader(survivorName)) as { id: number; content: string }[];
        for (const [index, r] of survRagRows.entries()) {
            rag.push({
                drop_short_id: keepShortId,
                drop_name: survivorName,
                fragment_id: r.id,
                header: r.content.slice(0, 60),
                version_count: ragSnapshotVersionCount(r.content),
                action: index === 0 ? 'kept' : 'consolidated',
            });
        }

        // Rename section (final_name ≠ survivor name).
        let rename: RenamePreviewDto | undefined;
        if (finalNameNorm !== survivorName) {
            const survHistCount = spec.history(campaignId, survivorName).length;
            const survHdr = db.prepare(
                `SELECT COUNT(*) AS c
                 FROM knowledge_fragments
                 WHERE campaign_id = ? AND session_id = ?
                   AND ${RAG_HEADER_SQL} = ? COLLATE BINARY`,
            ).get(campaignId, spec.fragmentType, spec.officialHeader(survivorName)) as { c: number };
            rename = {
                from: survivorName,
                to: finalNameNorm,
                history_repointed: survHistCount,
                rag_headers_rewritten: survHdr.c,
            };
        }

        return {
            survivor_short_id: keepShortId,
            survivor_name: survivorName,
            final_name: finalNameNorm,
            rename,
            record,
            events,
            relations,
            rag,
        };
    }

    // --- helpers ---

    private validateIdList(ids: string[], field: string, min: number, max: number): void {
        if (!Array.isArray(ids)) throw new BadRequestException(`${field} must be an array`);
        if (ids.length < min) throw new BadRequestException(`${field} must contain at least ${min} ids`);
        if (ids.length > max) throw new BadRequestException(`${field} must contain at most ${max} ids`);
        if (ids.some((id) => typeof id !== 'string' || !id.trim())) {
            throw new BadRequestException(`${field} must contain non-empty string ids`);
        }
        if (new Set(ids).size !== ids.length) throw new BadRequestException(`${field} must be unique`);
    }

    private resolveSelection(
        campaignId: number,
        spec: MergeEntitySpec,
        keepShortId: string,
        dropShortIds: string[],
    ): {
        survivor: MergeEntity;
        drops: Array<{ shortId: string; entity: MergeEntity }>;
    } {
        if (!keepShortId || typeof keepShortId !== 'string') {
            throw new BadRequestException('keep_short_id is required');
        }
        this.validateIdList(dropShortIds, 'drop_short_ids', 1, MAX_DROPS);
        if (dropShortIds.includes(keepShortId)) {
            throw new BadRequestException('keep_short_id cannot be in drop_short_ids');
        }
        const survivor = spec.getByShortId(campaignId, keepShortId);
        if (!survivor) throw new NotFoundException('Survivor entity not found');
        const drops = dropShortIds.map((shortId) => {
            const entity = spec.getByShortId(campaignId, shortId);
            if (!entity) throw new NotFoundException(`Drop entity ${shortId} not found`);
            if (entity.id === survivor.id) {
                throw new BadRequestException('Survivor and drop must be different records');
            }
            return { shortId, entity };
        });
        if (new Set(drops.map(({ entity }) => entity.id)).size !== drops.length) {
            throw new BadRequestException('drop_short_ids must resolve to unique records');
        }
        const selectionError = spec.validateSelection?.(
            survivor,
            drops.map(({ entity }) => entity),
        );
        if (selectionError) throw new BadRequestException(selectionError);
        return { survivor, drops };
    }

    private toMember(
        e: MergeEntity,
        all: MergeEntity[],
        bestEdge: Map<string, { score: number; reason: string }>,
        edgeKey: (a: number, b: number) => string,
        spec: MergeEntitySpec,
        campaignId: number,
        ragPresence: Set<string>,
    ): DuplicateMemberDto {
        // score of the best edge towards another cluster member (computed after pickSurvivor;
        // here we take the best edge towards any other entity in the group).
        const clusterPeers = all.filter((r) => r.id !== e.id);
        let bestScore = 0;
        let bestReason = 'normalized';
        for (const peer of clusterPeers) {
            const edge = bestEdge.get(edgeKey(e.id, peer.id));
            if (edge && edge.score > bestScore) {
                bestScore = edge.score;
                bestReason = edge.reason;
            }
        }
        return {
            short_id: e.short_id || '',
            name: e.name,
            is_manual: e.is_manual ? 1 : 0,
            history_count: spec.history(campaignId, e.name).length,
            has_rag: ragPresence.has(e.name.toLowerCase()),
            description: typeof e.description === 'string' ? e.description : null,
            score: bestScore,
            reason: bestReason,
        };
    }

    private pickSurvivor(members: DuplicateMemberDto[]): string {
        // 1) manual entity (takes priority: we do not want to lose its data)
        const manual = members.find((m) => m.is_manual === 1);
        if (manual) return manual.short_id;
        // 2) more history events (a "richer" entity)
        let best = members[0];
        for (const m of members) {
            if (m.history_count > best.history_count) best = m;
            else if (m.history_count === best.history_count && m.name.length > best.name.length) best = m;
        }
        return best.short_id;
    }

    /** Set of (lowercase) names that have a *_UPDATE RAG card in the DB. */
    private computeRagPresence(campaignId: number, fragmentType: string): Set<string> {
        const rows = db.prepare(
            `SELECT content FROM knowledge_fragments WHERE campaign_id = ? AND session_id = ?`,
        ).all(campaignId, fragmentType) as { content: string }[];
        const presence = new Set<string>();
        for (const r of rows) {
            const name = parseSchedaName(r.content);
            if (name) presence.add(name.toLowerCase());
        }
        return presence;
    }
}
