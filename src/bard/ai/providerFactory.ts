import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider } from '../../config';
import { getPooled, poolCacheKey } from './clientPool';
import { secretVault } from '../../services/secretVault';
import type { ResolvedCredentials } from './types';

/**
 * Provider registry.
 *
 * Replaces the chain of `if`s in `bard/config.ts`: adding a provider becomes a
 * change to one file instead of one more branch in a hundred lines of nested
 * conditions.
 *
 * ⚠️ `Secret.reveal()` is allowed **only** when constructing an SDK client and
 * during vault rotation. The list of authorized files is verified by
 * `tests/unit/services/secretExposure.test.ts`: a new call site makes that test
 * fail until it is explicitly justified.
 */

const OPENAI_TIMEOUT_MS = 1800 * 1000;
const CLOUD_TIMEOUT_MS = 1200 * 1000;

export interface ProviderAdapter {
    /** Builds (or reuses from the pool) the SDK client for these credentials. */
    createClient(creds: ResolvedCredentials): OpenAI;
    /**
     * Minimal call to verify that the key is accepted.
     *
     * It lives here and not in the API service because it is provider knowledge:
     * Anthropic has no OpenAI-compatible endpoint, so a probe written once on
     * the common client would say "invalid key" to a perfectly good one.
     * It throws on rejection: the caller classifies the error.
     */
    probe(creds: ResolvedCredentials, model: string): Promise<void>;
}

/** Never the key in the cache key: only its fingerprint. */
export function fingerprintOf(creds: ResolvedCredentials): string {
    return creds.apiKey ? secretVault.fingerprintOf(creds.apiKey.reveal()) : 'none';
}

function pooledOpenAiClient(
    creds: ResolvedCredentials,
    options: { baseURL?: string; timeout: number; project?: string },
): OpenAI {
    const cacheKey = poolCacheKey([
        creds.provider, options.baseURL, options.project, options.timeout, fingerprintOf(creds),
    ]);
    return getPooled(cacheKey, creds.scope.guildId, () => new OpenAI({
        apiKey: creds.apiKey?.reveal() ?? '',
        baseURL: options.baseURL,
        project: options.project,
        timeout: options.timeout,
    }));
}

/**
 * Anthropic has no OpenAI-compatible endpoint: it is only spoken to through the
 * native SDK. This stub exists to honour the common signature and to fail with
 * an explicit message should a call site forget to branch onto the native path,
 * instead of producing an incomprehensible authentication error.
 */
function anthropicMisuseStub(): OpenAI {
    return {
        chat: {
            completions: {
                create: () => {
                    throw new Error(
                        'Anthropic non supporta l\'endpoint OpenAI-compatible: usa il percorso ' +
                        'nativo (generateAnthropicNativeJson/Text, runAnthropicNativeAgent).',
                    );
                },
            },
        },
    } as unknown as OpenAI;
}

/** A one-token request: enough to know whether the key is accepted. */
async function openAiCompatProbe(client: OpenAI, model: string): Promise<void> {
    await client.chat.completions.create({
        model,
        max_completion_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
    });
}

export const PROVIDER_ADAPTERS: Record<AIProvider, ProviderAdapter> = {
    openai: {
        createClient: (creds) => pooledOpenAiClient(creds, {
            timeout: OPENAI_TIMEOUT_MS,
            project: creds.projectId || undefined,
        }),
        probe: (creds, model) => openAiCompatProbe(PROVIDER_ADAPTERS.openai.createClient(creds), model),
    },

    gemini: {
        createClient: (creds) => pooledOpenAiClient(creds, {
            baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
            timeout: CLOUD_TIMEOUT_MS,
        }),
        probe: (creds, model) => openAiCompatProbe(PROVIDER_ADAPTERS.gemini.createClient(creds), model),
    },

    anthropic: {
        createClient: () => anthropicMisuseStub(),
        // The only path is the native SDK: probing with the common client
        // would declare a perfectly good key invalid.
        probe: async (creds, model) => {
            const client = getPooled(
                poolCacheKey(['anthropic-native', fingerprintOf(creds)]),
                creds.scope.guildId,
                () => new Anthropic({ apiKey: creds.apiKey?.reveal() ?? '' }),
            );
            await client.messages.create({
                model,
                max_tokens: 1,
                messages: [{ role: 'user', content: 'ping' }],
            });
        },
    },

    'ollama-cloud': {
        createClient: (creds) => pooledOpenAiClient(creds, {
            baseURL: creds.baseUrl,
            timeout: CLOUD_TIMEOUT_MS,
        }),
        probe: (creds, model) => openAiCompatProbe(PROVIDER_ADAPTERS['ollama-cloud'].createClient(creds), model),
    },

    ollama: {
        createClient: (creds) => pooledOpenAiClient(creds, {
            baseURL: creds.baseUrl,
            timeout: OPENAI_TIMEOUT_MS,
        }),
        probe: (creds, model) => openAiCompatProbe(PROVIDER_ADAPTERS.ollama.createClient(creds), model),
    },
};

export function createProviderClient(creds: ResolvedCredentials): OpenAI {
    return PROVIDER_ADAPTERS[creds.provider].createClient(creds);
}

/** Verifies that the provider accepts these credentials. Throws if it rejects them. */
export function probeProviderCredentials(creds: ResolvedCredentials, model: string): Promise<void> {
    return PROVIDER_ADAPTERS[creds.provider].probe(creds, model);
}
