/**
 * Bard Reconciliation - Shared semantic module (embedding-based)
 *
 * Catches the identities that matching on the NAME cannot see: the same entity under
 * different labels (title vs proper name, a rephrased quest title, an item
 * described with different words). Used by every per-entity reconciler.
 *
 * - LOCAL/free embedding (nomic via Ollama) of the new entity's description.
 * - Shortlist by cosine against the vectors of the existing RAG dossiers (reusing the
 *   `*_UPDATE` fragments, no recomputation). TTL cache so the DB is not re-read for every entity.
 * - The "same entity" confirmation runs on the reconcile client (Ollama remote-first → local).
 *
 * Precision rule: semantic candidates NEVER auto-merge — they always go through
 * the AI confirmation based on the DESCRIPTIONS (never on the phonetics of the name).
 */

import { getKnowledgeFragments } from '../../db';
import { getReconcileClient } from '../config';
import { campaignEmbeddingModel } from '../ai/embeddings';
import { cosineSimilarity } from '../helpers';
import { generateText } from '../llm/generate';
import { embedText } from '../llm/embeddings';
import { scopeForCampaign } from '../ai/scope';

export const SEMANTIC_THRESHOLD = 0.72; // recall-friendly shortlist; precision comes from the AI confirmation
export const SEMANTIC_TOP_K = 3;
const VEC_CACHE_TTL = 60_000;

export interface EntityVector { key: string; vector: number[]; }
export interface SemanticHit { key: string; similarity: number; }

const _vecCache = new Map<string, { ts: number; vectors: EntityVector[] }>();

/**
 * Extracts the entity's name/key from the header of a RAG card, e.g.:
 *   "[[SCHEDA UFFICIALE: Vescovo]]"            → "Vescovo"
 *   "[[SCHEDA MISSIONE UFFICIALE: La piaga]]"  → "La piaga"
 *   "[[SCHEDA LUOGO UFFICIALE: Caelum - Porte]]" → "Caelum - Porte"
 */
export function parseSchedaName(content: string | null | undefined): string | null {
    if (!content) return null;
    const m = content.match(/\[\[SCHEDA[^\]:]*:\s*([^\]]+?)\s*\]\]/);
    return m ? m[1].trim() : null;
}

/**
 * Loads (with a TTL cache) the vectors of the RAG fragments of a given type
 * (e.g. 'DOSSIER_UPDATE', 'QUEST_UPDATE'), mapping each fragment to an entity
 * KEY through `extractKey`. It reuses the already stored embeddings: no recomputation.
 */
export function getEntityVectors(
    campaignId: number,
    fragmentType: string,
    extractKey: (fragment: any) => string | null
): EntityVector[] {
    const cacheKey = `${campaignId}:${fragmentType}`;
    const cached = _vecCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < VEC_CACHE_TTL) return cached.vectors;

    const fragments = getKnowledgeFragments(campaignId, campaignEmbeddingModel(campaignId))
        .filter((f: any) => f.session_id === fragmentType && f.embedding_json);

    const vectors: EntityVector[] = [];
    const seen = new Set<string>();
    for (const f of fragments as any[]) {
        try {
            const key = extractKey(f);
            if (!key) continue;
            const lower = key.toLowerCase();
            if (seen.has(lower)) continue; // one vector per entity (the latest official dossier)
            const vector = JSON.parse(f.embedding_json);
            if (Array.isArray(vector) && vector.length > 0) {
                vectors.push({ key, vector });
                seen.add(lower);
            }
        } catch { /* frammento malformato: skip */ }
    }

    _vecCache.set(cacheKey, { ts: Date.now(), vectors });
    return vectors;
}

/** Invalidates the vector cache (e.g. after a merge that rewrites the dossiers). */
export function invalidateEntityVectors(campaignId?: number): void {
    if (campaignId == null) { _vecCache.clear(); return; }
    for (const k of Array.from(_vecCache.keys())) {
        if (k.startsWith(`${campaignId}:`)) _vecCache.delete(k);
    }
}

/**
 * Embeds a text with the campaign's model. Fault-tolerant → null.
 *
 * It has to use the **same model** as the already stored vectors, or the cosine
 * would compare different spaces and produce meaningless similarities: hence the
 * mandatory `campaignId` instead of the ambient scope.
 */
export async function embedTextForCampaign(text: string, campaignId: number): Promise<number[] | null> {
    try {
        return await embedText(text, scopeForCampaign(campaignId));
    } catch (e) {
        console.warn(`[Reconcile] ⚠️ Embedding semantico non disponibile: ${(e as Error).message}`);
        return null;
    }
}

/**
 * Generic semantic shortlist: embeds `queryText` and compares it (cosine) with the vectors
 * of the existing dossiers of the given type. Returns the keys above threshold, sorted.
 * Fault-tolerant: if the embedding does not answer or there are no vectors, it returns [].
 */
export async function semanticShortlist(
    campaignId: number,
    queryText: string,
    fragmentType: string,
    extractKey: (fragment: any) => string | null,
    opts: { threshold?: number; topK?: number } = {}
): Promise<SemanticHit[]> {
    const threshold = opts.threshold ?? SEMANTIC_THRESHOLD;
    const topK = opts.topK ?? SEMANTIC_TOP_K;

    const vectors = getEntityVectors(campaignId, fragmentType, extractKey);
    if (vectors.length === 0) return [];

    const queryVector = await embedTextForCampaign(queryText, campaignId);
    if (!queryVector) return [];

    const hits: SemanticHit[] = [];
    for (const v of vectors) {
        const sim = cosineSimilarity(queryVector, v.vector);
        if (sim >= threshold) hits.push({ key: v.key, similarity: sim });
    }
    hits.sort((a, b) => b.similarity - a.similarity);
    return hits.slice(0, topK);
}

/**
 * "Same entity" confirmation via the reconcile client (Ollama remote-first → local).
 * The prompt is built by the caller (specific per type) and must ask for a YES/NO answer.
 */
export async function aiConfirmSameEntity(prompt: string, logLabel = 'Reconcile'): Promise<boolean> {
    try {
        const ai = await generateText({
            route: await getReconcileClient(),
            label: 'reconcile',
            system: 'Answer only YES or NO.',
            prompt,
            maxTokens: 10,
            temperature: 0,
            reasoningEffort: 'low'
        });
        const answer = ai.content.toUpperCase().trim();
        return answer.includes("YES") || answer.includes("SI") || answer.includes("SÌ");
    } catch (e) {
        console.error(`[${logLabel}] ❌ Errore AI semantic confirm:`, e);
        return false;
    }
}
