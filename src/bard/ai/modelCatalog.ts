import type { AIProvider } from '../../config';
import {
    resolveImagePricing,
    resolvePricing,
    resolveTranscriptionPricing,
    type ModelPricing,
} from '../../monitor/costs';
import {
    modelCatalogRepository,
    type CatalogRecord,
} from '../../db/repositories/ModelCatalogRepository';
import type { AiTier } from './types';

/**
 * What to offer in the selects.
 *
 * It is not a list of everything that exists: a provider's full catalogue is
 * long, changes every month and contains models that make no sense here. Anyone
 * who knows what they want can type any id by hand — the API accepts free
 * strings, and unlisted models work just the same.
 *
 * The list itself is **refreshed nightly** by `services/modelCatalogRefresh.ts`
 * and read from `model_catalog`. What stays committed here is the part a
 * download cannot supply: the note explaining a model to someone who does not
 * know the names, and which one to preselect. That is also the answer when the
 * table is empty — a fresh installation, or one that never had network.
 *
 * The distinction between the two groups is not a matter of taste but of
 * economics:
 *
 *  - **Quality** (`analyst` + writer) runs a few times per session, on long
 *    prompts, and is where it is decided whether the summary is readable. An
 *    expensive model belongs there.
 *  - **Fast** (metadata, map, chat, narrative filter, reconciliation, RAG) runs
 *    hundreds of times. A flagship model here multiplies the spend without much
 *    improving a mechanical task.
 */

export interface CatalogEntry {
    id: string;
    /** Help note for those who do not know the model names. */
    label: string;
    tiers: AiTier[];
    /** Recommended for that group: it is what the UI preselects. */
    recommendedFor: AiTier[];
}

/**
 * Exported because the periodic refresh (`services/modelCatalogRefresh.ts`)
 * merges it over what it downloads: these labels and these `recommendedFor` are
 * editorial judgement, not data a price list can carry, and they must survive
 * every rebuild of the catalogue.
 */
export const CATALOG: Record<AIProvider, CatalogEntry[]> = {
    openai: [
        { id: 'gpt-5.6-sol', label: 'Il più capace, e il più caro', tiers: ['quality'], recommendedFor: [] },
        { id: 'gpt-5.6-terra', label: 'Equilibrato', tiers: ['quality'], recommendedFor: ['quality'] },
        { id: 'gpt-5.6-luna', label: 'Leggero e rapido', tiers: ['quality', 'fast'], recommendedFor: [] },
        { id: 'gpt-5.4-mini', label: 'Economico', tiers: ['fast'], recommendedFor: ['fast'] },
        { id: 'gpt-5.4-nano', label: 'Il più economico', tiers: ['fast'], recommendedFor: [] },
    ],
    gemini: [
        { id: 'gemini-3.1-pro-preview', label: 'Il più capace', tiers: ['quality'], recommendedFor: ['quality'] },
        { id: 'gemini-3.5-flash', label: 'Rapido, contesto ampio', tiers: ['quality', 'fast'], recommendedFor: [] },
        { id: 'gemini-3-flash-preview', label: 'Rapido ed economico', tiers: ['fast'], recommendedFor: ['fast'] },
        { id: 'gemini-3.1-flash-lite', label: 'Il più economico', tiers: ['fast'], recommendedFor: [] },
    ],
    // Not offered by the UI: they do not cover the whole pipeline (see AI_PROVIDERS).
    // They stay empty rather than absent because the type still contains them, and a
    // self-hoster can force them from `ai.config.json`.
    anthropic: [],
    'ollama-cloud': [],
    // On your own hardware: no cost in money, and only that node knows which
    // models are installed. The list is a starting point, not a constraint.
    ollama: [
        { id: 'qwen3:14b', label: 'Buon compromesso su una GPU da 12 GB', tiers: ['quality', 'fast'], recommendedFor: ['quality'] },
        { id: 'qwen3:8b', label: 'Più leggero', tiers: ['fast'], recommendedFor: ['fast'] },
        { id: 'gemma3:12b', label: 'Alternativa', tiers: ['quality', 'fast'], recommendedFor: [] },
    ],
};

/**
 * Cloud transcription models, with their provider.
 *
 * **OpenAI and Gemini only**, and not out of preference:
 *
 *  - **Anthropic** does not accept audio in the Messages API. Its own official
 *    cookbook transcribes with a third-party service and then passes the text to
 *    Claude: offering it here would mean putting an option that fails in a select.
 *  - **Ollama** does not support audio input: the feature request is still open
 *    on the project, so there is nothing to call.
 *
 * This is the fallback the refresh merges over, exactly like `CATALOG`: an
 * instance that has never reached the network still has a usable list.
 */
export const BUILTIN_TRANSCRIPTION_MODELS: Record<string, AIProvider> = {
    // Endpoint dedicato, timestamp in secondi frazionari: la resa migliore.
    'gpt-4o-mini-transcribe': 'openai',
    'gpt-4o-transcribe': 'openai',
    'whisper-1': 'openai',
    // A general-purpose model with structured output: per-second timestamps, but
    // it costs less and above all **reuses the key the table already has**.
    'gemini-3.6-flash': 'gemini',
    'gemini-3-flash-preview': 'gemini',
    'gemini-3.1-flash-lite': 'gemini',
};

/**
 * Image models, the committed fallback.
 *
 * Kept apart from `CATALOG` because they share nothing with it: no tiers (there
 * is one image select, not two), no context window, and a price per picture
 * rather than per million tokens. The ids are the ones the installed SDKs
 * accept — anything else here would be a select entry that fails on use.
 *
 * The rates live in `monitor/costs.ts#IMAGE_PRICING`, next to the other two
 * units, and the nightly refresh overwrites all of this when it can reach the
 * network.
 */
export const IMAGE_CATALOG: Partial<Record<AIProvider, Array<{
    id: string;
    label: string | null;
    recommended: boolean;
}>>> = {
    openai: [
        { id: 'gpt-image-2', label: 'Il più recente', recommended: true },
        { id: 'gpt-image-1.5', label: 'Precedente, ancora ottimo', recommended: false },
        { id: 'gpt-image-1-mini', label: 'Il più economico', recommended: false },
    ],
    gemini: [
        // Consigliato perché è l'unico che regge davvero le immagini di
        // riferimento — la livrea di una fazione, il ritratto già accettato — e
        // quindi l'unico con cui un personaggio resta sé stesso da una
        // generazione all'altra. Costa circa tre volte il flash.
        { id: 'gemini-3-pro-image', label: 'Il più fedele, e il più caro', recommended: true },
        { id: 'gemini-3.1-flash-image', label: 'Equilibrato', recommended: false },
        { id: 'gemini-2.5-flash-image', label: 'Il più economico', recommended: false },
        // Ritirati da Google per i progetti nuovi: su un account recente
        // rispondono 404. Restano per chi li aveva già.
        { id: 'imagen-4.0-generate-001', label: 'Legacy', recommended: false },
        { id: 'imagen-4.0-ultra-generate-001', label: 'Legacy', recommended: false },
    ],
};

/**
 * One entry of a select.
 *
 * The price is **structured, not spelled into the label**: it used to be
 * concatenated into the help note, which meant the UI could only print it back
 * as it came. Separate fields let it be laid out, aligned and compared — which
 * is the whole point of showing it at the moment of the choice.
 *
 * `null` in a price field means we do not know the rate. It does not mean free:
 * `runsOnYourHardware` is what says free.
 */
export interface ModelOption {
    id: string;
    label: string | null;
    recommended: boolean;
    /** USD per 1M tokens. */
    inputPerMillion: number | null;
    outputPerMillion: number | null;
    /** USD per minute of audio, transcription models only. */
    perMinuteUsd: number | null;
    /** USD per generated picture, image models only. */
    perImageUsd: number | null;
    contextTokens: number | null;
    /** Costs time and electricity rather than money — and that has to be said. */
    runsOnYourHardware: boolean;
}

function optionFrom(record: CatalogRecord, tier: AiTier | null): ModelOption {
    return {
        id: record.modelId,
        label: record.label,
        recommended: tier !== null && record.recommendedFor.includes(tier),
        inputPerMillion: record.inputPerMillion,
        outputPerMillion: record.outputPerMillion,
        perMinuteUsd: record.perMinuteUsd,
        perImageUsd: record.perImageUsd,
        contextTokens: record.contextTokens,
        runsOnYourHardware: record.provider === 'ollama',
    };
}

/** The curated list, used whenever the refreshed catalogue has nothing to say. */
function builtinOptions(provider: AIProvider, tier: AiTier): ModelOption[] {
    return CATALOG[provider]
        .filter(entry => entry.tiers.includes(tier))
        .map(entry => {
            const pricing = provider === 'ollama' ? null : resolvePricing(entry.id);
            return {
                id: entry.id,
                label: entry.label,
                recommended: entry.recommendedFor.includes(tier),
                inputPerMillion: pricing?.input ?? null,
                outputPerMillion: pricing?.output ?? null,
                perMinuteUsd: null,
                perImageUsd: null,
                contextTokens: null,
                runsOnYourHardware: provider === 'ollama',
            };
        });
}

/**
 * The models offered for a provider and a group.
 *
 * Reads the refreshed catalogue and falls back to the curated list when it is
 * empty — a fresh installation, or one that has never had network. An empty
 * select would be a worse answer than a slightly dated one.
 */
export function modelsFor(provider: AIProvider, tier: AiTier): ModelOption[] {
    const records = modelCatalogRepository.list('text', provider)
        .filter(record => record.tiers.includes(tier));
    if (records.length === 0) return builtinOptions(provider, tier);
    return records.map(record => optionFrom(record, tier));
}

/** The transcription models offered for a provider, cheapest first. */
export function transcriptionModelsFor(provider: AIProvider): ModelOption[] {
    const records = modelCatalogRepository.list('transcription', provider);
    if (records.length > 0) return records.map(record => optionFrom(record, null));

    return Object.entries(BUILTIN_TRANSCRIPTION_MODELS)
        .filter(([, owner]) => owner === provider)
        .map(([id]) => ({
            id,
            label: null,
            recommended: false,
            inputPerMillion: null,
            outputPerMillion: null,
            perMinuteUsd: resolveTranscriptionPricing(id),
            perImageUsd: null,
            contextTokens: null,
            runsOnYourHardware: false,
        }));
}

/**
 * Which provider owns a transcription model.
 *
 * The catalogue answers first because it knows models released after this file
 * was written; the curated map answers when it is empty.
 */
export function providerOfTranscriptionModel(model: string): AIProvider | null {
    const record = modelCatalogRepository.list('transcription')
        .find(entry => entry.modelId === model);
    return record?.provider ?? BUILTIN_TRANSCRIPTION_MODELS[model] ?? null;
}

/**
 * What a minute of cloud transcription costs, or `null` when we do not know.
 *
 * The catalogue wins over the committed table because it covers Gemini too,
 * which the table never did: a table transcribing on Gemini used to be told its
 * price was unknown when it was perfectly knowable.
 */
export function transcriptionPricePerMinute(model: string): number | null {
    const record = modelCatalogRepository.list('transcription')
        .find(entry => entry.modelId === model);
    return record?.perMinuteUsd ?? resolveTranscriptionPricing(model);
}

/**
 * The image models offered, cheapest first.
 *
 * **Only `openai` and `gemini`**, and only because those are the two that hold a
 * BYOK key and speak an image API this app implements. Ollama is absent for a
 * plainer reason than preference: it has no image-generation endpoint, so
 * offering it would put an option in a select that always fails.
 */
export function imageModelsFor(provider: AIProvider): ModelOption[] {
    const records = modelCatalogRepository.list('image', provider);
    // `recommended` here is one flag, not a per-group answer: there is a single
    // image select, so a non-empty `recommendedFor` simply means "preselect me".
    if (records.length > 0) {
        return records.map(record => ({
            ...optionFrom(record, null),
            recommended: record.recommendedFor.length > 0,
        }));
    }

    return (IMAGE_CATALOG[provider] ?? []).map(entry => ({
        id: entry.id,
        label: entry.label,
        recommended: entry.recommended,
        inputPerMillion: null,
        outputPerMillion: null,
        perMinuteUsd: null,
        perImageUsd: resolveImagePricing(entry.id),
        contextTokens: null,
        runsOnYourHardware: false,
    }));
}

/**
 * What one generated picture costs, or `null` when we do not know.
 *
 * `null` is not zero here more emphatically than anywhere else: a portrait is
 * the single most expensive action a table can trigger, several hundred times a
 * chat message, and showing it as free would be the costliest possible place to
 * round an unknown down.
 */
export function imagePricePerImage(model: string): number | null {
    const record = modelCatalogRepository.list('image')
        .find(entry => entry.modelId === model);
    return record?.perImageUsd ?? resolveImagePricing(model);
}

/** Which provider owns an image model — the catalogue first, then the curated list. */
export function providerOfImageModel(model: string): AIProvider | null {
    const record = modelCatalogRepository.list('image')
        .find(entry => entry.modelId === model);
    if (record) return record.provider;

    for (const [provider, entries] of Object.entries(IMAGE_CATALOG)) {
        if (entries.some(entry => entry.id === model)) return provider as AIProvider;
    }
    return null;
}

/** Per-1M-token rate from the refreshed catalogue, if it carries the model. */
export function catalogPricing(model: string): ModelPricing | null {
    const record = modelCatalogRepository.list('text')
        .find(entry => entry.modelId === model);
    if (!record || record.inputPerMillion === null || record.outputPerMillion === null) return null;
    return {
        input: record.inputPerMillion,
        output: record.outputPerMillion,
        cachedInput: record.cachedInputPerMillion ?? 0,
    };
}

/** When the catalogue was last rebuilt. `null` while it is still the curated list. */
export function catalogRefreshedAt(): number | null {
    return modelCatalogRepository.refreshedAt();
}

/** The model to preselect for a group, when the provider has a recommended one. */
export function recommendedModel(provider: AIProvider, tier: AiTier): string | null {
    return CATALOG[provider].find(entry => entry.recommendedFor.includes(tier))?.id ?? null;
}
