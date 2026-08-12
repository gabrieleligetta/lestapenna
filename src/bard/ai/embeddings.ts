import type { AIProvider } from '../../config';
import { db } from '../../db/client';
import { resolveCredentials } from './credentials';
import { isOllamaAlive, stripV1Suffix } from './resolver';
import { resolveTranscription } from './transcription';
import type { AiScope, ResolvedCredentials } from './types';

/**
 * Which model this campaign turns text into vectors with.
 *
 * It is the one choice in the pipeline that **cannot be changed without
 * consequences**. `knowledge_fragments.embedding_model` is already a search
 * filter, so changing model corrupts nothing: it simply makes every already
 * computed vector invisible. The RAG stops remembering, and tells nobody.
 *
 * That is why the model **is pinned to the campaign at the first indexing** and
 * stays there. Changing it is an explicit action that reindexes, not a default
 * that drifts because the guild's configuration changed in the meantime.
 *
 * The default for a new campaign, in order:
 *
 *  1. **The Ollama on the table's PC**, if it has configured one for
 *     transcription: it is their own hardware, and embeddings cost nothing there.
 *  2. **Their cloud key**, otherwise. It really does cost very little — a
 *     fragment is around 200 tokens, and a hundred-session campaign stays under
 *     a cent — but it is their money and it should be said.
 *
 * There is no instance Ollama node: everyone's embeddings on the operator's
 * hardware is the same thing as whisper.cpp on the server, removed in phase 0
 * for the same reason.
 */

export interface EmbeddingModelInfo {
    provider: AIProvider;
    model: string;
    /** Length of the vector. Mixing two different ones breaks the cosine. */
    dimension: number;
    /** USD per million tokens. Zero on the table's own hardware. */
    usdPerMillionTokens: number;
}

/** The embedding models we know how to use, with their dimension. */
export const EMBEDDING_MODELS: Record<string, EmbeddingModelInfo> = {
    'nomic-embed-text': { provider: 'ollama', model: 'nomic-embed-text', dimension: 768, usdPerMillionTokens: 0 },
    'mxbai-embed-large': { provider: 'ollama', model: 'mxbai-embed-large', dimension: 1024, usdPerMillionTokens: 0 },
    'text-embedding-3-small': { provider: 'openai', model: 'text-embedding-3-small', dimension: 1536, usdPerMillionTokens: 0.02 },
    'text-embedding-3-large': { provider: 'openai', model: 'text-embedding-3-large', dimension: 3072, usdPerMillionTokens: 0.13 },
    'gemini-embedding-001': { provider: 'gemini', model: 'gemini-embedding-001', dimension: 3072, usdPerMillionTokens: 0.15 },
};

export const DEFAULT_LOCAL_EMBEDDING_MODEL = 'nomic-embed-text';

/** The cloud model to offer to whoever has that provider's key. */
const DEFAULT_CLOUD_EMBEDDING_MODEL: Partial<Record<AIProvider, string>> = {
    openai: 'text-embedding-3-small',
    gemini: 'gemini-embedding-001',
};

export interface ResolvedEmbedding extends EmbeddingModelInfo {
    creds: ResolvedCredentials;
    /** True when the model was already pinned to the campaign. */
    pinned: boolean;
}

export class EmbeddingNotConfiguredError extends Error {
    readonly code = 'EMBEDDING_NOT_CONFIGURED';
    constructor(readonly scope: AiScope) {
        super(
            'Nessun modello di embedding utilizzabile per questa campagna: ' +
            'serve un Ollama raggiungibile sul PC del tavolo, oppure una chiave ' +
            'OpenAI o Gemini.',
        );
        this.name = 'EmbeddingNotConfiguredError';
    }
}

interface CampaignEmbeddingRow {
    embedding_model: string | null;
    embedding_dimension: number | null;
}

function pinnedFor(campaignId: number): CampaignEmbeddingRow | undefined {
    return db.prepare('SELECT embedding_model, embedding_dimension FROM campaigns WHERE id = ?')
        .get(campaignId) as CampaignEmbeddingRow | undefined;
}

/**
 * The address of the table's Ollama.
 *
 * If it has a PC for transcription, that PC is normally also its Ollama node:
 * we try the standard port on the same host. It is a default, not a silent
 * assumption — if it does not answer we do not fall back onto anything paid, and
 * the table chooses explicitly.
 */
export function tenantOllamaUrl(scope: AiScope): string | null {
    const transcription = resolveTranscription(scope);
    if (transcription.engine !== 'remote') return null;

    try {
        const url = new URL(transcription.remote.url);
        return `${url.protocol}//${url.hostname}:11434/v1`;
    } catch {
        return null;
    }
}

/**
 * Resolves the campaign's embedding model.
 *
 * `probeOllama` exists for the callers that cannot wait for a network probe —
 * the cost estimate shown on the page, for example.
 */
export async function resolveEmbedding(
    scope: AiScope,
    options: { probeOllama?: boolean } = {},
): Promise<ResolvedEmbedding> {
    const { probeOllama = true } = options;
    const pinned = scope.campaignId ? pinnedFor(scope.campaignId) : undefined;

    // The already pinned model wins over everything: changing it here would mean
    // making the campaign's memory invisible without anyone having asked for
    // that.
    if (pinned?.embedding_model) {
        const info = EMBEDDING_MODELS[pinned.embedding_model] ?? {
            provider: 'ollama' as AIProvider,
            model: pinned.embedding_model,
            dimension: pinned.embedding_dimension ?? 0,
            usdPerMillionTokens: 0,
        };
        return { ...info, creds: credsFor(info.provider, scope), pinned: true };
    }

    const chosen = await chooseDefault(scope, probeOllama);
    if (!chosen) throw new EmbeddingNotConfiguredError(scope);
    return { ...chosen, creds: credsFor(chosen.provider, scope), pinned: false };
}

async function chooseDefault(scope: AiScope, probeOllama: boolean): Promise<EmbeddingModelInfo | null> {
    const ollamaUrl = tenantOllamaUrl(scope);
    if (ollamaUrl && (!probeOllama || await isOllamaAlive(ollamaUrl))) {
        return EMBEDDING_MODELS[DEFAULT_LOCAL_EMBEDDING_MODEL];
    }

    // No hardware of their own: we look at which key they actually have.
    for (const provider of ['openai', 'gemini'] as AIProvider[]) {
        if (resolveCredentials(provider, scope).source !== 'none') {
            return EMBEDDING_MODELS[DEFAULT_CLOUD_EMBEDDING_MODEL[provider]!];
        }
    }
    return null;
}

function credsFor(provider: AIProvider, scope: AiScope): ResolvedCredentials {
    const creds = resolveCredentials(provider, scope);
    if (provider === 'ollama') {
        creds.baseUrl = tenantOllamaUrl(scope) ?? creds.baseUrl;
    }
    return creds;
}

/**
 * The model this campaign indexed with, used to filter the search.
 *
 * Synchronous on purpose: search calls it on every question, and it must not
 * depend on a network probe. If the campaign has not indexed anything yet, the
 * value does not matter — there are no fragments to filter.
 */
export function campaignEmbeddingModel(campaignId: number): string {
    return pinnedFor(campaignId)?.embedding_model ?? DEFAULT_LOCAL_EMBEDDING_MODEL;
}

/** Pins the model to the campaign, at the first indexing or at a reindex. */
export function pinEmbeddingModel(campaignId: number, model: string, dimension: number): void {
    db.prepare('UPDATE campaigns SET embedding_model = ?, embedding_dimension = ? WHERE id = ?')
        .run(model, dimension, campaignId);
}

/** What indexing that many characters would cost, on the given model. */
export function estimateEmbeddingCostUsd(model: string, totalChars: number): number | null {
    const info = EMBEDDING_MODELS[model];
    if (!info) return null;
    // ~4 characters per token: the same approximation as the rest of the pipeline.
    return (totalChars / 4 / 1_000_000) * info.usdPerMillionTokens;
}

export { stripV1Suffix };
