/**
 * Generic factory for entity name reconciliation.
 *
 * item.ts / monster.ts / quest.ts were copy-pasted triplets of the same
 * flow: exact match → levenshtein/substring candidates → semantic shortlist
 * (embedding) → AI confirmation on the top 3. Here the flow lives once; the
 * per-entity files shrink to a declarative spec (~15 lines) and wrappers
 * that preserve the historical names and result shapes.
 *
 * location.ts and npc.ts do NOT use this factory: they have extra logic
 * (macro/micro, event overlap, PC check) that must not be forced into the template.
 */

import { levenshteinSimilarity, containsSubstring, stripPrefix } from '../helpers';
import { semanticShortlist, parseSchedaName, aiConfirmSameEntity } from './semantic';

export interface ReconcilerSpec<T> {
    /** Prefisso log, es. 'Item Reconcile'. */
    label: string;
    listEntities(campaignId: number): T[];
    getName(entity: T): string;
    getDescription(entity: T): string;
    /** Levenshtein threshold below which the candidate is discarded. */
    nameThreshold(newNameClean: string, existingNameClean: string): number;
    /** Similarity fittizia assegnata ai match per substring. */
    substringScore: number;
    /** RAG fragment type for the semantic shortlist (e.g. 'INVENTORY_UPDATE'). */
    semanticFragmentType: string;
    /** Soglia cosine per la shortlist semantica (default: quella globale). */
    semanticThreshold?: number;
    confirmNamePrompt(name1: string, name2: string, context: string): string;
    confirmSemanticPrompt(newName: string, newDesc: string, candName: string, candDesc: string): string;
    /** true (monster): passes the description as context to the confirmation on the name. */
    passDescriptionToNameConfirm?: boolean;
}

export interface ReconcileMatch<T> {
    canonicalName: string;
    existing: T;
}

/** Builds the `reconcileName(campaignId, name, description)` function for the entity. */
export function createNameReconciler<T>(spec: ReconcilerSpec<T>) {
    const confirmName = (name1: string, name2: string, context = '') =>
        aiConfirmSameEntity(spec.confirmNamePrompt(name1, name2, context), spec.label);

    return async function reconcileName(
        campaignId: number,
        newName: string,
        newDescription: string = ''
    ): Promise<ReconcileMatch<T> | null> {
        const existingEntities = spec.listEntities(campaignId);
        if (existingEntities.length === 0) return null;

        const newNameLower = newName.toLowerCase().trim();
        const newNameClean = stripPrefix(newNameLower);

        // 1. Match esatto (case-insensitive)
        const exactMatch = existingEntities.find(e => spec.getName(e).toLowerCase() === newNameLower);
        if (exactMatch) {
            console.log(`[${spec.label}] ✅ Match esatto (case-insensitive): "${newName}" = "${spec.getName(exactMatch)}"`);
            return { canonicalName: spec.getName(exactMatch), existing: exactMatch };
        }

        // 2. Candidati sintattici: levenshtein + substring
        const candidates: Array<{ entity: T; similarity: number; reason: string }> = [];
        for (const entity of existingEntities) {
            const existingNameClean = stripPrefix(spec.getName(entity).toLowerCase());
            const similarity = levenshteinSimilarity(newNameClean, existingNameClean);

            if (similarity >= spec.nameThreshold(newNameClean, existingNameClean)) {
                candidates.push({ entity, similarity, reason: `levenshtein=${similarity.toFixed(2)}` });
                continue;
            }
            if (containsSubstring(newNameClean, existingNameClean)) {
                candidates.push({ entity, similarity: spec.substringScore, reason: 'substring_match' });
            }
        }

        // 3. Semantic fallback (different names, same entity): only when there are no
        //    strong candidates and the description is long enough to embed.
        if (candidates.filter(c => c.similarity >= 0.85).length === 0 && newDescription.length > 30) {
            const hits = await semanticShortlist(
                campaignId,
                `${newName}. ${newDescription}`,
                spec.semanticFragmentType,
                f => parseSchedaName(f.content),
                spec.semanticThreshold !== undefined ? { threshold: spec.semanticThreshold } : {}
            );
            const byName = new Map(existingEntities.map(e => [spec.getName(e).toLowerCase(), e]));
            for (const hit of hits) {
                const existing = byName.get(hit.key.toLowerCase());
                if (existing && !candidates.some(c => spec.getName(c.entity) === spec.getName(existing))) {
                    console.log(`[${spec.label}] 🧠 Candidato semantico: "${newName}" ~ "${spec.getName(existing)}" (cosine=${hit.similarity.toFixed(2)})`);
                    candidates.push({ entity: existing, similarity: hit.similarity, reason: 'semantic_match' });
                }
            }
        }

        if (candidates.length === 0) return null;
        candidates.sort((a, b) => b.similarity - a.similarity);

        // 4. AI confirmation on the top 3 (semantic candidates use the description-based prompt)
        for (const candidate of candidates.slice(0, 3)) {
            const candName = spec.getName(candidate.entity);
            console.log(`[${spec.label}] 🔍 "${newName}" simile a "${candName}" (${candidate.reason}). Chiedo conferma AI...`);

            const isSame = candidate.reason === 'semantic_match'
                ? await aiConfirmSameEntity(
                    spec.confirmSemanticPrompt(newName, newDescription, candName, spec.getDescription(candidate.entity)),
                    spec.label)
                : await confirmName(newName, candName, spec.passDescriptionToNameConfirm ? newDescription : '');

            if (isSame) {
                console.log(`[${spec.label}] ✅ CONFERMATO: "${newName}" = "${candName}"`);
                return { canonicalName: candName, existing: candidate.entity };
            }
            console.log(`[${spec.label}] ❌ "${newName}" ≠ "${candName}"`);
        }

        return null;
    };
}

export interface BatchDeduperSpec<I> {
    /** Prefisso log, es. 'Item Batch Dedup'. */
    label: string;
    getKey(item: I): string;
    /** Soglia levenshtein oltre la quale si chiede conferma AI. */
    threshold: number;
    confirm(name1: string, name2: string): Promise<boolean>;
    /** Merges `other` into `merged` (in place; the longer name already won upstream). */
    merge(merged: I, other: I): void;
}

/**
 * Builds the `deduplicateBatch(items)` function: O(n²) dedupe with AI confirmation
 * for the pairs above threshold, identical in flow for every entity.
 */
export function createBatchDeduper<I extends Record<string, any>>(spec: BatchDeduperSpec<I>) {
    return async function deduplicateBatch(items: I[]): Promise<I[]> {
        if (items.length <= 1) return items;

        const result: I[] = [];
        const processed = new Set<number>();

        for (let i = 0; i < items.length; i++) {
            if (processed.has(i)) continue;

            const merged = { ...items[i] } as I;
            processed.add(i);

            for (let j = i + 1; j < items.length; j++) {
                if (processed.has(j)) continue;

                const similarity = levenshteinSimilarity(spec.getKey(merged), spec.getKey(items[j]));
                const hasSubstring = containsSubstring(spec.getKey(merged), spec.getKey(items[j]));

                if (similarity > spec.threshold || hasSubstring) {
                    const isSame = await spec.confirm(spec.getKey(merged), spec.getKey(items[j]));
                    if (isSame) {
                        console.log(`[${spec.label}] 🔄 "${spec.getKey(items[j])}" → "${spec.getKey(merged)}"`);
                        spec.merge(merged, items[j]);
                        processed.add(j);
                    }
                }
            }

            result.push(merged);
        }

        if (result.length < items.length) {
            console.log(`[${spec.label}] ✅ Ridotti ${items.length} a ${result.length}`);
        }
        return result;
    };
}
