import OpenAI from 'openai';
import { loadAiConfig, type AIProvider, type PhaseConfig } from '../../config';
import { tenantAiSettingsRepository } from '../../db/repositories/TenantAiSettingsRepository';
import { resolveCredentials } from './credentials';
import { createProviderClient } from './providerFactory';
import { invalidateScope } from './clientPool';
import {
    AiNotConfiguredError,
    TIER_PHASES,
    tierOfPhase,
    type AiPhase,
    type AiScope,
    type AiTier,
    type ResolvedCredentials,
} from './types';

/**
 * Per-tenant resolution of the AI configuration.
 *
 * Precedence, from the most specific:
 *
 *   the table's settings (`tenant_ai_settings`)
 *     → `ai.config.local.json` (or `AI_CONFIG_LOCAL`)
 *       → `ai.config.json`
 *
 * The file level stays because self-hosting and the tests need it: the suite
 * points `AI_CONFIG_LOCAL` at a fixture and expects that to keep holding.
 */

/** Forma salvata in `tenant_ai_settings.settings_json`. */
export interface TenantAiSettings {
    /** The only two choices the UI exposes. */
    tiers?: Partial<Record<AiTier, { provider: AIProvider; model: string }>>;
    /** Per-phase overrides, from a campaign's advanced settings. */
    phases?: Partial<Record<AiPhase, { provider: AIProvider; model: string }>>;
    ollama?: { remoteUrl?: string; localUrl?: string };
    /** How the table turns audio into text. See `ai/transcription.ts`. */
    transcription?: import('./transcription').TranscriptionSettings;
    /**
     * Rates declared by the table, which win over our price list.
     *
     * Anyone with an enterprise discount or using the Batch API really does pay
     * something else, and imposing our prices on them would be a lie about their
     * own invoice.
     */
    pricingOverrides?: import('../../services/pricingSource').TenantPricingOverride[];
    /** Pipeline choices. Set per campaign, not per guild. */
    features?: {
        /**
         * Semi-agentic summary instead of the linear pipeline.
         *
         * It changes the cost considerably, so it is a choice of the table and
         * not an instance default: the agent queries the game world several
         * times over, and every round is one more call.
         */
        agenticSummary?: boolean;
    };
}

export interface AiRoute {
    client: OpenAI;
    model: string;
    provider: AIProvider;
    creds: ResolvedCredentials;
    scope: AiScope;
}

export interface AiContext {
    scope: AiScope;
    /** A phase's provider and model, without building clients or calling anything. */
    phaseConfig(phase: AiPhase): PhaseConfig;
    /** The full route, credentials included. Throws if the table has none. */
    route(phase: AiPhase): Promise<AiRoute>;
    limits(phase: AiPhase): { input: number; output: number };
    chunking(): { maxChunkSize: number; chunkOverlap: number };
    concurrency(phase: AiPhase): number;
}

const CHARS_PER_TOKEN = 4;

const PROVIDER_CONTEXT_LIMITS: Record<AIProvider, { input: number; output: number }> = {
    openai: { input: 1_050_000, output: 128_000 }, // gpt-5.6-sol/terra/luna
    gemini: { input: 1_048_576, output: 65_536 },  // gemini-3.1-pro-preview / 3.5-flash
    ollama: { input: 32_768, output: 4_096 },
    'ollama-cloud': { input: 976_000, output: 32_768 }, // GLM-5.2:cloud
    anthropic: { input: 1_000_000, output: 128_000 },   // opus-4-8 / sonnet-5
};

export function contextLimitsFor(provider: AIProvider): { input: number; output: number } {
    return PROVIDER_CONTEXT_LIMITS[provider];
}

/**
 * The settings applicable to the scope, from the most general to the most specific.
 *
 * The guild decides the two groups and owns the keys; a campaign may override
 * the **model** of a single phase from the advanced settings. It cannot override
 * the keys: the advanced section moves *which model*, never *who pays* — which
 * is why only `phases` are merged, while `tiers` and `ollama` stay the guild's.
 */
function tenantSettingsFor(scope: AiScope): TenantAiSettings | undefined {
    const guild = tenantAiSettingsRepository.get<TenantAiSettings>('guild', scope.guildId)?.settings;
    if (!scope.campaignId) return guild;

    const campaign = tenantAiSettingsRepository
        .get<TenantAiSettings>('campaign', String(scope.campaignId))?.settings;
    if (!campaign) return guild;

    return {
        ...guild,
        phases: { ...guild?.phases, ...campaign.phases },
        // The pipeline choices belong to the campaign too: two campaigns on the
        // same server may want different pipelines, and often do.
        features: { ...guild?.features, ...campaign.features },
    };
}

/**
 * A phase's configuration, applying the precedence.
 *
 * The group → phases expansion happens here, so `ai.config.json` and the test
 * fixtures keep their per-phase shape and do not have to be rewritten.
 */
function resolvePhaseConfig(phase: AiPhase, settings: TenantAiSettings | undefined): PhaseConfig {
    const cfg = loadAiConfig();
    // Two optional keys, each with the nearest sensible stand-in: a config
    // written before they existed must still resolve rather than throw.
    // `image` falls back to nothing usable in text terms, so it borrows the
    // fallback entry and lets the credential check produce the real error.
    const fileConfig = phase === 'reconcile'
        ? (cfg.phases.reconcile ?? cfg.phases.metadata)
        : phase === 'image'
            ? (cfg.phases.image ?? cfg.fallback)
            : cfg.phases[phase];

    const override = settings?.phases?.[phase];
    if (override) return { ...fileConfig, ...override };

    const tier = tierOfPhase(phase);
    const tierChoice = tier ? settings?.tiers?.[tier] : undefined;
    if (tierChoice) return { ...fileConfig, ...tierChoice };

    return fileConfig;
}

/**
 * Ollama has no credentials but it has an address, and that really is per table:
 * each person's own home PC. Try the remote one, then the local one.
 */
async function resolveOllamaBaseUrl(settings: TenantAiSettings | undefined): Promise<string> {
    const cfg = loadAiConfig();
    const remote = settings?.ollama?.remoteUrl ?? cfg.ollama.remoteUrl;
    const local = settings?.ollama?.localUrl ?? cfg.ollama.localUrl;

    if (await isOllamaAlive(remote)) return remote;
    if (remote !== local && await isOllamaAlive(local)) return local;
    // Neither answers: we go back to the remote one so an explicit error
    // surfaces instead of a client pointed at nothing.
    return remote;
}

/** Strips the /v1 suffix (the OpenAI-compatible endpoint) for Ollama's native API. */
export function stripV1Suffix(url: string): string {
    return url.replace(/\/v1\/?$/, '');
}

const HEALTH_CACHE_MS = 60_000;
const healthCache = new Map<string, { models: string[] | null; checkedAt: number }>();

/**
 * The models installed on an Ollama node, or `null` if it did not answer.
 *
 * `/api/tags` is the same call that used to be made twice for two different
 * questions — «is it up?» and «what is on it?» — because the answer to the
 * second contains the answer to the first. One call, one cache.
 *
 * On the table's own hardware this is the **only** truthful source: no catalogue
 * can know what someone pulled onto their own machine.
 */
export async function listOllamaModels(baseUrl: string): Promise<string[] | null> {
    const cached = healthCache.get(baseUrl);
    if (cached && Date.now() - cached.checkedAt < HEALTH_CACHE_MS) return cached.models;

    let models: string[] | null = null;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(`${stripV1Suffix(baseUrl)}/api/tags`, { signal: controller.signal });
        clearTimeout(timeout);
        if (response.ok) {
            const data = await response.json() as { models?: Array<{ name?: string }> };
            models = (data.models ?? [])
                .map(entry => entry.name)
                .filter((name): name is string => typeof name === 'string');
        }
    } catch {
        models = null;
    }
    healthCache.set(baseUrl, { models, checkedAt: Date.now() });
    return models;
}

export async function isOllamaAlive(baseUrl: string): Promise<boolean> {
    return (await listOllamaModels(baseUrl)) !== null;
}

export function clearHealthCache(): void {
    healthCache.clear();
}

export function getAiContext(scope: AiScope): AiContext {
    const settings = tenantSettingsFor(scope);
    const cfg = loadAiConfig();

    const phaseConfig = (phase: AiPhase): PhaseConfig => resolvePhaseConfig(phase, settings);

    return {
        scope,
        phaseConfig,

        async route(phase: AiPhase): Promise<AiRoute> {
            const config = phaseConfig(phase);
            const creds = resolveCredentials(config.provider, scope);

            if (creds.source === 'none') {
                throw new AiNotConfiguredError(
                    phase, config.provider, creds.secretKey ?? 'credenziale', scope,
                );
            }

            let model = config.model;
            if (config.provider === 'ollama') {
                const baseUrl = await resolveOllamaBaseUrl(settings);
                creds.baseUrl = baseUrl;
                const local = settings?.ollama?.localUrl ?? cfg.ollama.localUrl;
                // On the local node we use the reduced model, when declared.
                if (baseUrl === local && config.localModel) model = config.localModel;
            }

            return {
                client: createProviderClient(creds),
                model,
                provider: config.provider,
                creds,
                scope,
            };
        },

        limits: (phase) => contextLimitsFor(phaseConfig(phase).provider),

        chunking: () => {
            const provider = phaseConfig('map').provider;
            return {
                maxChunkSize: cfg.chunkSize[provider] * CHARS_PER_TOKEN,
                chunkOverlap: cfg.chunkOverlap[provider] * CHARS_PER_TOKEN,
            };
        },

        concurrency: (phase) => cfg.concurrency[phaseConfig(phase).provider],
    };
}

/**
 * Invalidates everything that has been memoized for a guild.
 *
 * To be called when the table saves settings or changes a key: without it the
 * UI would say one thing and the system would do another until the pool's TTL
 * expires.
 */
/**
 * Does this campaign's summary go through the semi-agentic flow?
 *
 * Default: whatever the instance's configuration file says, so a self-host does
 * not have to touch anything to get the previous behaviour.
 */
export function isAgenticSummaryEnabled(scope: AiScope): boolean {
    const settings = tenantSettingsFor(scope);
    return settings?.features?.agenticSummary ?? loadAiConfig().features.enableAgenticSummary;
}

export function invalidateTenant(guildId: string): void {
    invalidateScope(guildId);
    healthCache.clear();
}

export { TIER_PHASES };
