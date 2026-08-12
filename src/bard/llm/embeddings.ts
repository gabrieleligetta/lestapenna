/**
 * Single helper for the RAG embeddings.
 *
 * They are no longer always local Ollama. They stayed that way because of a real
 * constraint — the model is stored per fragment and used as a filter, so
 * changing it makes the already computed vectors invisible — but the
 * consequence was that a table with only an OpenAI key had **a completely dead
 * RAG, with no diagnostics at all**. The model is now resolved per campaign and
 * pinned at the first indexing: see `ai/embeddings.ts`.
 */

import { resolveEmbedding, type ResolvedEmbedding } from '../ai/embeddings';
import { requireAiScope } from '../ai/ambientScope';
import { scopeForCampaign } from '../ai/scope';
import { createProviderClient } from '../ai/providerFactory';
import { classifyProviderError, redactKeyLike } from '../ai/providerErrors';
import { flagCredential } from '../ai/credentials';
import { monitor } from '../../monitor';
import type { AiScope } from '../ai/types';

/**
 * Estimate of the tokens consumed.
 *
 * The embedding endpoints return `usage.prompt_tokens`, but not all of them and
 * not always: when it is missing we approximate 4 characters per token, as in the
 * rest of the pipeline. A declared estimate is better than a zero, which the cost
 * layer would read as "free" — and that was exactly the earlier defect.
 */
function tokensOf(response: any, texts: string[]): number {
    const reported = response?.usage?.prompt_tokens;
    if (typeof reported === 'number' && reported > 0) return reported;
    return Math.ceil(texts.reduce((total, text) => total + text.length, 0) / 4);
}

async function resolveFor(scope?: AiScope): Promise<ResolvedEmbedding> {
    return resolveEmbedding(scope ?? requireAiScope());
}

function logUsage(resolved: ResolvedEmbedding, tokens: number, startedAt: number, failed: boolean): void {
    monitor.logAIRequestWithCost(
        'embeddings',
        // The REAL provider and model: they used to always be 'ollama' and zero tokens,
        // so as soon as embeddings could cost something, real spend was recorded
        // as €0.
        resolved.provider,
        resolved.model,
        tokens, 0, 0,
        Date.now() - startedAt,
        failed,
    );
}

function handleProviderError(resolved: ResolvedEmbedding, error: unknown): void {
    const classified = classifyProviderError(resolved.provider, error);
    if (classified.kind === 'QUOTA_EXHAUSTED' || classified.kind === 'AUTH_FAILED') {
        flagCredential(resolved.creds, classified.kind, redactKeyLike(classified.raw));
    }
}

/**
 * Embeds a single text. It rethrows the error (callers decide the tolerance
 * policy), but always logs cost and latency to the monitor.
 */
export async function embedText(text: string, scope?: AiScope): Promise<number[]> {
    const resolved = await resolveFor(scope);
    const start = Date.now();
    try {
        const client = createProviderClient(resolved.creds);
        const response = await client.embeddings.create({ model: resolved.model, input: text });
        logUsage(resolved, tokensOf(response, [text]), start, false);
        return response.data[0].embedding as number[];
    } catch (err) {
        logUsage(resolved, 0, start, true);
        handleProviderError(resolved, err);
        throw err;
    }
}

/**
 * Embeds an array of texts in ONE call, saving a round trip per chunk during
 * ingestion. If the batch fails it degrades to per-item, so an error does not
 * lose everything. Returns `null` in the positions of the failed texts.
 */
export async function embedTexts(texts: string[], scope?: AiScope): Promise<Array<number[] | null>> {
    if (texts.length === 0) return [];
    if (texts.length === 1) {
        try { return [await embedText(texts[0], scope)]; } catch { return [null]; }
    }

    const resolved = await resolveFor(scope);
    const start = Date.now();
    try {
        const client = createProviderClient(resolved.creds);
        const response = await client.embeddings.create({ model: resolved.model, input: texts });
        logUsage(resolved, tokensOf(response, texts), start, false);

        // The API guarantees ordering via index: we remap for safety.
        //
        // ⚠️ `index` has to be read as «missing means 0». Gemini's compatible
        // endpoint **does not emit `index` for the first element**: it is
        // Google's protobuf JSON, which omits fields at their default value, and
        // 0 is the default of an integer. Taken literally, the first fragment of
        // every batch was lost — out of 253 fragments at 32 at a time, eight
        // pieces of memory gone in silence, which is the worst way this code can
        // break. The position in the array is the right source: responses come
        // back in order, and `index` only serves to confirm it.
        const byIndex = new Map(response.data.map((d: any, position: number) => [
            typeof d.index === 'number' ? d.index : position,
            d.embedding as number[],
        ]));
        return texts.map((_, i) => byIndex.get(i) ?? null);
    } catch (err: any) {
        logUsage(resolved, 0, start, true);
        handleProviderError(resolved, err);
        console.warn(`[Embeddings] ⚠️ Batch da ${texts.length} fallito (${err?.message}), fallback per-item...`);

        const results: Array<number[] | null> = [];
        for (const text of texts) {
            try { results.push(await embedText(text, scope)); } catch { results.push(null); }
        }
        return results;
    }
}

/** Embeds in a campaign's context, without depending on the ambient scope. */
export function embedTextForCampaign(text: string, campaignId: number): Promise<number[]> {
    return embedText(text, scopeForCampaign(campaignId));
}
