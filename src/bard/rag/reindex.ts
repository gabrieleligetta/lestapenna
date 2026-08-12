import { db } from '../../db/client';
import { knowledgeRepository } from '../../db';
import {
    EMBEDDING_MODELS,
    campaignEmbeddingModel,
    estimateEmbeddingCostUsd,
    pinEmbeddingModel,
} from '../ai/embeddings';
import { embedTexts } from '../llm/embeddings';
import { scopeForCampaign } from '../ai/scope';

/**
 * Reindexing: recomputes every vector of a campaign onto another model.
 *
 * It is needed because changing model **corrupts nothing but makes everything
 * invisible**: `embedding_model` is a search filter, so the old vectors stay in
 * the database and simply stop being found. The RAG would stop remembering
 * without telling anyone — silent amnesia, the worst way to break.
 *
 * The fragments' `content` is stored, so the original transcripts are not
 * needed: the text is re-read and re-embedded.
 *
 * **Nothing is deleted.** If the recomputation fails halfway, the campaign goes
 * back to the previous model and keeps working; the fragments that could not be
 * re-embedded stay where they were, invisible but recoverable with a second
 * pass. Losing a campaign's memory to a network error would be an absurd price
 * for a change of model.
 */

export interface ReindexEstimate {
    fragments: number;
    totalChars: number;
    currentModel: string;
    targetModel: string;
    estimatedUsd: number | null;
}

export interface ReindexResult {
    reindexed: number;
    failed: number;
    model: string;
}

/** How many fragments there are and what moving them to another model would cost. */
export function estimateReindex(campaignId: number, targetModel: string): ReindexEstimate {
    const currentModel = campaignEmbeddingModel(campaignId);
    // What is left to do is what is NOT already on the target model: on a
    // recovery pass, counting the fragments on the current model would announce
    // the work just finished instead of the few left behind.
    const row = db.prepare(`
        SELECT COUNT(*) AS fragments, COALESCE(SUM(LENGTH(content)), 0) AS chars
        FROM knowledge_fragments WHERE campaign_id = ? AND embedding_model <> ?
    `).get(campaignId, targetModel) as { fragments: number; chars: number };

    return {
        fragments: row.fragments,
        totalChars: row.chars,
        currentModel,
        targetModel,
        estimatedUsd: estimateEmbeddingCostUsd(targetModel, row.chars),
    };
}

const REINDEX_BATCH = 32;

export async function reindexCampaign(campaignId: number, targetModel: string): Promise<ReindexResult> {
    const info = EMBEDDING_MODELS[targetModel];
    if (!info) throw new Error(`Modello di embedding sconosciuto: ${targetModel}`);

    const currentModel = campaignEmbeddingModel(campaignId);

    /**
     * The campaign is already on the target model: this is a **recovery** pass
     * over the fragments a transient error left behind, not a change of model.
     * It changes what to do on failure — putting the campaign back on the old
     * model would make the already converted fragments invisible, that is,
     * almost all of them.
     */
    const isRecovery = currentModel === targetModel;

    const fragments = knowledgeRepository.getFragmentsNotOnModel(campaignId, info.model);
    if (fragments.length === 0) {
        // No memory to move: it is simply pinned.
        pinEmbeddingModel(campaignId, info.model, info.dimension);
        return { reindexed: 0, failed: 0, model: targetModel };
    }

    // The model is pinned BEFORE embedding, or `embedTexts` would still resolve
    // the old one and the work would be pointless.
    pinEmbeddingModel(campaignId, info.model, info.dimension);
    const scope = scopeForCampaign(campaignId);

    const rebuilt: Array<{ id: number; vector: number[] }> = [];
    let failed = 0;

    try {
        for (let start = 0; start < fragments.length; start += REINDEX_BATCH) {
            const batch = fragments.slice(start, start + REINDEX_BATCH);
            const vectors = await embedTexts(batch.map(f => f.content), scope);

            batch.forEach((fragment, index) => {
                const vector = vectors[index];
                if (!vector || (info.dimension > 0 && vector.length !== info.dimension)) {
                    failed++;
                    return;
                }
                rebuilt.push({ id: fragment.id, vector });
            });

            console.log(`[RAG] 🔁 Reindicizzazione: ${Math.min(start + REINDEX_BATCH, fragments.length)}/${fragments.length}`);
        }
    } catch (error) {
        // We roll back: the campaign stays on the model that can still
        // read it. Not in recovery, where the old model is the one of the few
        // fragments left behind and going back to it would hide all the others.
        if (!isRecovery) pinEmbeddingModel(campaignId, currentModel, fragments[0]?.vector_dimension ?? 0);
        throw error;
    }

    if (rebuilt.length === 0) {
        // In recovery there is nothing to undo: the campaign was already fine
        // before and stays that way, with a few fragments still to pick up.
        if (isRecovery) return { reindexed: 0, failed, model: targetModel };

        pinEmbeddingModel(campaignId, currentModel, fragments[0]?.vector_dimension ?? 0);
        throw new Error('REINDEX_FAILED: nessun frammento reindicizzato, la campagna resta sul modello precedente');
    }

    knowledgeRepository.applyReindexedVectors(campaignId, info.model, info.dimension, rebuilt);
    return { reindexed: rebuilt.length, failed, model: targetModel };
}
