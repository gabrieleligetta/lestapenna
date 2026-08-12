import * as cron from 'node-cron';
import type { AIProvider } from '../config';
import { CATALOG, IMAGE_CATALOG } from '../bard/ai/modelCatalog';
import { IMAGE_OUTPUT_TOKENS, resolveImagePricing } from '../monitor/costs';
import type { AiTier } from '../bard/ai/types';
import {
    modelCatalogRepository,
    type CatalogRecord,
    type ModelKind,
} from '../db/repositories/ModelCatalogRepository';
import { logger } from '../utils/logger';

const log = logger('ModelCatalog');

/**
 * Keeping the models offered in the settings up to date.
 *
 * The providers publish new models every month, and until now every one of them
 * required a release: the list was hardcoded. This job downloads it instead.
 *
 * **Where the prices come from.** No provider exposes them: `GET /v1/models` on
 * OpenAI, `models.list` on Gemini and `/v1/models` on Anthropic all return ids
 * and capabilities, never a rate. So the source is two public databases, both
 * MIT-licensed:
 *
 *  - **models.dev** (`sst/models.dev`) — per-1M-token prices, modalities,
 *    context limits, release dates. It is the primary source for text models;
 *  - **LiteLLM's price list** (`BerriAI/litellm`) — the only one that covers
 *    OpenAI's transcription models, which models.dev does not carry at all.
 *
 * **Neither is load-bearing.** Both can be down, both can go away: the job logs
 * and leaves the previous catalogue in place, and an instance that has never
 * reached them serves the curated list committed in `bard/ai/modelCatalog.ts`.
 * A self-hoster behind a firewall must get a working settings page, not an
 * empty select.
 */

const MODELS_DEV_URL = 'https://models.dev/api.json';
const LITELLM_PRICES_URL =
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** Generous: these are multi-megabyte files, and nothing waits on them. */
const FETCH_TIMEOUT_MS = 30_000;

/** After the janitor's 04:00, so two heavy jobs do not overlap. */
const CATALOG_SCHEDULE = '30 4 * * *';

/** Delay of the run at startup: the boot must not wait for the network. */
const STARTUP_DELAY_MS = 60_000;

/**
 * How models.dev names the providers we offer.
 *
 * Gemini is under `google` there, and `AI_PROVIDERS` in the API only admits
 * `openai` and `gemini` anyway — Anthropic and Ollama Cloud do not cover the
 * whole pipeline, and Ollama is the table's own hardware, asked live.
 */
const PROVIDER_KEYS: Record<string, AIProvider> = {
    openai: 'openai',
    google: 'gemini',
};

// --- Curation policy -------------------------------------------------------
//
// Downloading everything would put ~90 models in a select, most of them
// meaningless here. What follows cuts that to about twenty, with rules that can
// be stated rather than a list to maintain by hand.

/** Anything older is superseded; keeping it only makes the select longer. */
const MAX_MODEL_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Above this, a four-hour session costs more than the hardware that would run
 * it locally. The `-pro` tiers ($15–$180 per 1M) are real models and a real
 * choice, but not one to put two clicks away from someone configuring their
 * first table. Anyone who wants them types the id: the API accepts it.
 */
const MAX_INPUT_USD_PER_MILLION = 10;

/**
 * The boundary between the two groups, in USD per 1M input tokens.
 *
 * It is not a matter of taste but of economics, the same one written in
 * `modelCatalog.ts`: `quality` runs a few times per session on long prompts,
 * `fast` runs hundreds of times. A model priced at the boundary belongs to both.
 */
const TIER_BOUNDARY_USD_PER_MILLION = 1;

/**
 * Ids that are not choices: aliases that move under your feet (`-latest`),
 * dated snapshots, other modalities, and variants of a model already listed.
 */
const EXCLUDED_ID_PATTERN =
    /realtime|audio|tts|image|embed|moderation|search|instruct|codex|transcribe|whisper|robotics|customtools|deep-research|live|-latest$|-\d{4}-\d{2}-\d{2}$/;

/**
 * The same list minus the modality words, for the Gemini transcription pass.
 *
 * There «accepts audio» is the selection criterion, so excluding ids that
 * mention audio would throw away exactly what is being looked for.
 */
const EXCLUDED_TRANSCRIPTION_ID_PATTERN =
    /robotics|customtools|deep-research|live|embed|-latest$|-\d{4}-\d{2}-\d{2}$/;

/**
 * Audio tokens per minute, for the models billed per token rather than per
 * minute.
 *
 * Both figures are checks, not guesses: 2400 tok/min reproduces exactly the
 * $0.003 and $0.006 per minute OpenAI publishes for `gpt-4o-mini-transcribe`
 * and `gpt-4o-transcribe`, and 1920 (the 32 tokens per second already stated in
 * `workers/scriba.ts`) reproduces the Gemini figures in
 * `docs/OPEN-SOURCE-BYOK.md`.
 */
const OPENAI_AUDIO_TOKENS_PER_MINUTE = 2400;
const GEMINI_AUDIO_TOKENS_PER_MINUTE = 1920;

/**
 * Ids to skip in the image pass.
 *
 * `deep-research` is in the list because the price file marks it
 * `image_generation` and it is not an image model — the entry is simply wrong at
 * the source, and offering it would put a select option that cannot draw. The
 * rest is the usual: experimental builds, moving aliases, dated snapshots.
 */
const EXCLUDED_IMAGE_ID_PATTERN = /deep-research|-exp-|-latest$|-\d{4}-\d{2}-\d{2}$/;

// --- Source shapes ---------------------------------------------------------

interface ModelsDevModel {
    id?: string;
    name?: string;
    tool_call?: boolean;
    structured_output?: boolean;
    release_date?: string;
    modalities?: { input?: string[]; output?: string[] };
    limit?: { context?: number; output?: number };
    cost?: { input?: number; output?: number; cache_read?: number };
}

interface ModelsDevProvider {
    models?: Record<string, ModelsDevModel>;
}

interface LiteLlmEntry {
    litellm_provider?: string;
    mode?: string;
    input_cost_per_second?: number;
    input_cost_per_audio_token?: number;
    supported_endpoints?: string[];
    /** Image models: a price per picture, where the provider publishes one. */
    output_cost_per_image?: number;
    input_cost_per_token?: number;
    output_cost_per_image_token?: number;
}

/**
 * How the LiteLLM list names the two providers whose image models we offer.
 *
 * Its `openai` and `gemini` only: the file also carries Bedrock, Vertex, Azure
 * and a handful of resellers, none of which this app can call — a table
 * configures an OpenAI or a Gemini key and nothing else.
 */
const LITELLM_IMAGE_PROVIDERS: Record<string, AIProvider> = {
    openai: 'openai',
    gemini: 'gemini',
};

// --- Parsing ---------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** A price we did not read is `null`, never 0: zero is a claim, absence is not. */
function price(value: unknown): number | null {
    return isFiniteNumber(value) ? value : null;
}

function tiersForPrice(inputPerMillion: number): AiTier[] {
    const tiers: AiTier[] = [];
    if (inputPerMillion <= TIER_BOUNDARY_USD_PER_MILLION) tiers.push('fast');
    if (inputPerMillion >= TIER_BOUNDARY_USD_PER_MILLION) tiers.push('quality');
    return tiers;
}

/**
 * The text models to offer, from models.dev.
 *
 * `tool_call` and `structured_output` are requirements, not preferences: every
 * phase of the pipeline asks for JSON back, and a model that cannot produce it
 * would fail on its first summary.
 */
export function parseModelsDevText(payload: unknown, now: number): CatalogRecord[] {
    const root = payload as Record<string, ModelsDevProvider> | null;
    if (!root || typeof root !== 'object') return [];

    const records: CatalogRecord[] = [];
    const oldestAccepted = now - MAX_MODEL_AGE_MS;

    for (const [key, provider] of Object.entries(PROVIDER_KEYS)) {
        for (const model of Object.values(root[key]?.models ?? {})) {
            const id = model.id;
            if (!id || EXCLUDED_ID_PATTERN.test(id)) continue;
            if (model.tool_call !== true || model.structured_output !== true) continue;

            const input = model.modalities?.input ?? [];
            const output = model.modalities?.output ?? [];
            if (!input.includes('text')) continue;
            if (output.length !== 1 || output[0] !== 'text') continue;

            const released = Date.parse(model.release_date ?? '');
            if (!Number.isFinite(released) || released < oldestAccepted) continue;

            // No price means we cannot say what it costs, and a select entry
            // whose cost is a shrug is not an improvement over one fewer entry.
            const inputPerMillion = price(model.cost?.input);
            if (inputPerMillion === null || inputPerMillion > MAX_INPUT_USD_PER_MILLION) continue;

            records.push({
                provider,
                modelId: id,
                kind: 'text',
                label: model.name ?? null,
                tiers: tiersForPrice(inputPerMillion),
                recommendedFor: [],
                inputPerMillion,
                outputPerMillion: price(model.cost?.output),
                cachedInputPerMillion: price(model.cost?.cache_read),
                perMinuteUsd: null,
                perImageUsd: null,
                contextTokens: price(model.limit?.context),
                maxOutputTokens: price(model.limit?.output),
                releaseDate: model.release_date ?? null,
                source: 'models.dev',
                refreshedAt: now,
            });
        }
    }
    return records;
}

/**
 * Gemini transcription models, from models.dev.
 *
 * Gemini has no dedicated transcription endpoint: a general-purpose model with
 * structured output does the job, which is why the filter is «accepts audio»
 * and not «is a transcriber». It is billed per token, so the per-minute figure
 * is derived — and it is the figure the table needs, because a session is
 * measured in hours of audio, not in tokens.
 */
export function parseModelsDevTranscription(payload: unknown, now: number): CatalogRecord[] {
    const root = payload as Record<string, ModelsDevProvider> | null;
    if (!root || typeof root !== 'object') return [];

    const records: CatalogRecord[] = [];
    const oldestAccepted = now - MAX_MODEL_AGE_MS;

    for (const model of Object.values(root.google?.models ?? {})) {
        const id = model.id;
        if (!id) continue;
        if (EXCLUDED_TRANSCRIPTION_ID_PATTERN.test(id)) continue;
        if (!(model.modalities?.input ?? []).includes('audio')) continue;
        if (model.structured_output !== true) continue;

        const released = Date.parse(model.release_date ?? '');
        if (!Number.isFinite(released) || released < oldestAccepted) continue;

        const inputPerMillion = price(model.cost?.input);
        if (inputPerMillion === null) continue;

        records.push({
            provider: 'gemini',
            modelId: id,
            kind: 'transcription',
            label: model.name ?? null,
            tiers: [],
            recommendedFor: [],
            inputPerMillion,
            outputPerMillion: price(model.cost?.output),
            cachedInputPerMillion: null,
            perMinuteUsd: (inputPerMillion / 1_000_000) * GEMINI_AUDIO_TOKENS_PER_MINUTE,
            perImageUsd: null,
            contextTokens: price(model.limit?.context),
            maxOutputTokens: null,
            releaseDate: model.release_date ?? null,
            source: 'models.dev',
            refreshedAt: now,
        });
    }
    return records;
}

/**
 * OpenAI transcription models, from LiteLLM.
 *
 * This is the one thing models.dev does not have. The two billing units both
 * appear here and both become a per-minute rate: `whisper-1` is priced per
 * second, the `gpt-4o-*-transcribe` family per audio token.
 */
export function parseLiteLlmTranscription(payload: unknown, now: number): CatalogRecord[] {
    const root = payload as Record<string, LiteLlmEntry> | null;
    if (!root || typeof root !== 'object') return [];

    const records: CatalogRecord[] = [];

    for (const [id, entry] of Object.entries(root)) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.mode !== 'audio_transcription') continue;
        if (entry.litellm_provider !== 'openai') continue;
        // The dedicated endpoint, not the realtime session: the worker uploads a
        // finished file and waits for segments back.
        if (!(entry.supported_endpoints ?? []).includes('/v1/audio/transcriptions')) continue;
        // Dated snapshots duplicate the moving id at the same price.
        if (/-\d{4}-\d{2}-\d{2}$/.test(id)) continue;

        const perSecond = price(entry.input_cost_per_second);
        const perAudioToken = price(entry.input_cost_per_audio_token);
        const perMinuteUsd = perSecond !== null
            ? perSecond * 60
            : perAudioToken !== null
                ? perAudioToken * OPENAI_AUDIO_TOKENS_PER_MINUTE
                : null;
        if (perMinuteUsd === null) continue;

        records.push({
            provider: 'openai',
            modelId: id,
            kind: 'transcription',
            label: null,
            tiers: [],
            recommendedFor: [],
            inputPerMillion: null,
            outputPerMillion: null,
            cachedInputPerMillion: null,
            perMinuteUsd,
            perImageUsd: null,
            contextTokens: null,
            maxOutputTokens: null,
            releaseDate: null,
            source: 'litellm',
            refreshedAt: now,
        });
    }
    return records;
}

/**
 * Image models, from the LiteLLM price list.
 *
 * models.dev does not carry them at all — the same gap it has for OpenAI's
 * transcription models — so this list is the only source, and the general
 * `EXCLUDED_ID_PATTERN` deliberately does not apply: it strips anything named
 * `image`, which here is precisely what is being looked for.
 *
 * **Two billing shapes, one column.** Gemini and Imagen publish a price per
 * picture and it is read straight off. The OpenAI `gpt-image-*` family is billed
 * in image tokens, so the per-picture figure is derived: the published output
 * tokens for one 1024×1024 at medium quality times the per-token rate. That
 * derivation is checked rather than assumed — for `gpt-image-1` it gives $0.042,
 * which is exactly what the independent per-pixel entry in the same file yields.
 *
 * The compound keys (`medium/1024-x-1024/gpt-image-1`, `azure/…`, `aiml/…`) are
 * skipped: they are the same models priced per size or resold by someone else,
 * and putting them in a select would offer four spellings of one choice.
 */
export function parseLiteLlmImage(payload: unknown, now: number): CatalogRecord[] {
    const root = payload as Record<string, LiteLlmEntry> | null;
    if (!root || typeof root !== 'object') return [];

    const records: CatalogRecord[] = [];

    for (const [id, entry] of Object.entries(root)) {
        if (!entry || entry.mode !== 'image_generation') continue;

        const vendor = entry.litellm_provider ?? '';
        const provider = LITELLM_IMAGE_PROVIDERS[vendor];
        if (!provider) continue;

        const modelId = stripVendorPrefix(id, vendor);
        // What is left with a slash in it is a size/quality variant
        // (`medium/1024-x-1024/gpt-image-1`) or a reseller's namespace, not a
        // model of its own; a trailing date is a snapshot of one already listed,
        // and `-latest` is an alias that moves under your feet.
        if (modelId.includes('/')) continue;
        if (EXCLUDED_IMAGE_ID_PATTERN.test(modelId)) continue;

        const perImageUsd = price(entry.output_cost_per_image)
            ?? derivePerImageFromTokens(entry);
        if (perImageUsd === null) continue;

        records.push({
            provider,
            modelId,
            kind: 'image',
            label: null,
            tiers: [],
            recommendedFor: [],
            inputPerMillion: perMillion(entry.input_cost_per_token),
            // The output of an image call is image tokens, where there are any.
            outputPerMillion: perMillion(entry.output_cost_per_image_token),
            cachedInputPerMillion: null,
            perMinuteUsd: null,
            perImageUsd,
            contextTokens: null,
            maxOutputTokens: null,
            releaseDate: null,
            source: 'litellm',
            refreshedAt: now,
        });
    }
    return dropPreviewTwins(records);
}

/**
 * A `-preview` next to its stable twin is the same model twice.
 *
 * Both are real and both work, but a select that offers
 * `gemini-3.1-flash-image` and `gemini-3.1-flash-image-preview` asks the reader
 * to tell apart two entries with the same price and the same behaviour. When
 * only the preview exists it stays: then it is the model.
 */
function dropPreviewTwins(records: CatalogRecord[]): CatalogRecord[] {
    const stable = new Set(
        records.filter(r => !r.modelId.endsWith('-preview')).map(r => r.modelId),
    );
    return records.filter(r =>
        !r.modelId.endsWith('-preview') || !stable.has(r.modelId.slice(0, -'-preview'.length)));
}

/**
 * `gemini/imagen-4.0-generate-001` is the Gemini model `imagen-4.0-generate-001`.
 *
 * The list namespaces some vendors' ids and not others, and the SDK wants the
 * bare name. Only the model's **own** vendor prefix is stripped, so a reseller's
 * (`aiml/…`) or a size variant's (`medium/…`) survives and is rejected below.
 */
function stripVendorPrefix(id: string, vendor: string): string {
    return id.startsWith(`${vendor}/`) ? id.slice(vendor.length + 1) : id;
}

/** Per-token rates arrive per single token; the catalogue stores them per million. */
function perMillion(value: unknown): number | null {
    const rate = price(value);
    return rate === null ? null : rate * 1_000_000;
}

/** One medium-quality 1024×1024, for a model that only publishes a token rate. */
function derivePerImageFromTokens(entry: LiteLlmEntry): number | null {
    const perImageToken = price(entry.output_cost_per_image_token);
    if (perImageToken === null) return null;
    return perImageToken * IMAGE_OUTPUT_TOKENS.medium;
}

// --- Merge with the curated list -------------------------------------------

function keyOf(provider: AIProvider, modelId: string, kind: ModelKind): string {
    return `${provider} ${modelId} ${kind}`;
}

function unique<T>(values: T[]): T[] {
    return [...new Set(values)];
}

/**
 * The curated list wins on judgement, the download wins on figures.
 *
 * Labels and `recommendedFor` are editorial: they are the only notes written for
 * someone who does not know the model names, and they are what the UI
 * preselects. Prices, context limits and release dates are data, and there the
 * download is the more recent truth.
 *
 * A curated model missing from the download stays anyway, without a price: it
 * may have been withdrawn, or the filter may have been too strict, and dropping
 * a table's currently configured model out of its own select is the worse of
 * the two failures.
 */
export function mergeWithBuiltin(fetched: CatalogRecord[], now: number): CatalogRecord[] {
    const byKey = new Map<string, CatalogRecord>();
    for (const record of fetched) {
        byKey.set(keyOf(record.provider, record.modelId, record.kind), record);
    }

    for (const [provider, entries] of Object.entries(CATALOG) as Array<[AIProvider, typeof CATALOG[AIProvider]]>) {
        for (const entry of entries) {
            const key = keyOf(provider, entry.id, 'text');
            const downloaded = byKey.get(key);
            byKey.set(key, {
                ...(downloaded ?? {
                    provider,
                    modelId: entry.id,
                    kind: 'text' as ModelKind,
                    inputPerMillion: null,
                    outputPerMillion: null,
                    cachedInputPerMillion: null,
                    perMinuteUsd: null,
                    perImageUsd: null,
                    contextTokens: null,
                    maxOutputTokens: null,
                    releaseDate: null,
                    source: 'builtin',
                    refreshedAt: now,
                }),
                label: entry.label,
                // Union rather than replacement: the price rule may have put a
                // model in one group only, and a recommendation for a group the
                // model is not in would never be shown.
                tiers: unique([...(downloaded?.tiers ?? []), ...entry.tiers]),
                recommendedFor: entry.recommendedFor,
            });
        }
    }

    // The same treatment for the image list: the download brings the rate, the
    // committed list brings the note and which one to preselect — and keeps a
    // model in the select even on an instance that has never had network.
    for (const [provider, entries] of Object.entries(IMAGE_CATALOG)) {
        for (const entry of entries) {
            const key = keyOf(provider as AIProvider, entry.id, 'image');
            const downloaded = byKey.get(key);
            byKey.set(key, {
                ...(downloaded ?? {
                    provider: provider as AIProvider,
                    modelId: entry.id,
                    kind: 'image' as ModelKind,
                    inputPerMillion: null,
                    outputPerMillion: null,
                    cachedInputPerMillion: null,
                    perMinuteUsd: null,
                    perImageUsd: resolveImagePricing(entry.id),
                    contextTokens: null,
                    maxOutputTokens: null,
                    releaseDate: null,
                    source: 'builtin',
                    refreshedAt: now,
                }),
                label: entry.label,
                tiers: [],
                // `recommended` on an image model is a single flag, not a group:
                // there is one image select, so `recommendedFor` carries both.
                recommendedFor: entry.recommended ? ['quality', 'fast'] : [],
            });
        }
    }

    return [...byKey.values()];
}

// --- The job ---------------------------------------------------------------

export interface RefreshOutcome {
    text: number;
    transcription: number;
    image: number;
    /** Sources that answered. Empty means the catalogue was left untouched. */
    sources: string[];
}

type JsonFetcher = (url: string) => Promise<unknown>;

async function fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            headers: { accept: 'application/json' },
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Rebuilds the catalogue.
 *
 * Tolerant by design: the two sources are independent, and one of them
 * answering is enough to be worth a rebuild. If **neither** answers, the
 * previous catalogue is left exactly where it is — an outage at models.dev must
 * not empty a working settings page.
 */
export async function runModelCatalogRefresh(
    options: { now?: number; fetcher?: JsonFetcher } = {},
): Promise<RefreshOutcome> {
    const now = options.now ?? Date.now();
    const fetcher = options.fetcher ?? fetchJson;

    const [modelsDev, liteLlm] = await Promise.allSettled([
        fetcher(MODELS_DEV_URL),
        fetcher(LITELLM_PRICES_URL),
    ]);

    const sources: string[] = [];
    const fetched: CatalogRecord[] = [];

    if (modelsDev.status === 'fulfilled') {
        fetched.push(...parseModelsDevText(modelsDev.value, now));
        fetched.push(...parseModelsDevTranscription(modelsDev.value, now));
        sources.push('models.dev');
    } else {
        log.warn(`models.dev unreachable: ${modelsDev.reason?.message ?? modelsDev.reason}`);
    }

    if (liteLlm.status === 'fulfilled') {
        fetched.push(...parseLiteLlmTranscription(liteLlm.value, now));
        // Image models come only from here: models.dev does not carry them at
        // all, the same gap it has for OpenAI's transcription models.
        fetched.push(...parseLiteLlmImage(liteLlm.value, now));
        sources.push('litellm');
    } else {
        log.warn(`LiteLLM price list unreachable: ${liteLlm.reason?.message ?? liteLlm.reason}`);
    }

    if (sources.length === 0) {
        log.warn('No source answered: the catalogue already stored is left untouched.');
        return { text: 0, transcription: 0, image: 0, sources: [] };
    }

    const merged = mergeWithBuiltin(fetched, now);
    modelCatalogRepository.replaceAll(merged);

    const outcome: RefreshOutcome = {
        text: merged.filter(r => r.kind === 'text').length,
        transcription: merged.filter(r => r.kind === 'transcription').length,
        image: merged.filter(r => r.kind === 'image').length,
        sources,
    };
    log.info(
        `Catalogue rebuilt: ${outcome.text} text models, ${outcome.transcription} transcription, ` +
        `${outcome.image} image (sources: ${sources.join(', ')})`,
    );
    return outcome;
}

/** Schedules the refresh. Called at boot, next to the janitor. */
export function startModelCatalogRefresh(): void {
    log.info(`Model catalogue refresh scheduled: ${CATALOG_SCHEDULE}`);

    // The catalogue survives a restart, so this is not a cold start: it is the
    // pass that picks up a model released while the instance was down.
    setTimeout(() => {
        runModelCatalogRefresh().catch(err => log.error('Startup refresh failed', err as Error));
    }, STARTUP_DELAY_MS);

    cron.schedule(CATALOG_SCHEDULE, async () => {
        await runModelCatalogRefresh().catch(err => log.error('Scheduled refresh failed', err as Error));
    });
}
