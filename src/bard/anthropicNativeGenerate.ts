import Anthropic from '@anthropic-ai/sdk';
import { safeJsonParse } from './helpers';
import { getPooled, poolCacheKey } from './ai/clientPool';
import { fingerprintOf } from './ai/providerFactory';
import type { ResolvedCredentials } from './ai/types';

export interface AnthropicNativeGenerateResult<T = any> {
    content: string;
    parsed?: T | null;
    usage: {
        input: number;
        output: number;
        total: number;
        cached: number;
    };
    latency: number;
}

/**
 * Native Anthropic client for the given credentials.
 *
 * It used to be a module singleton with the environment key: see the twin note
 * in geminiNativeGenerate.ts — it is the point at which every table's spend
 * would have silently landed on the operator.
 */
function getAnthropicAi(creds: ResolvedCredentials): Anthropic {
    const cacheKey = poolCacheKey(['anthropic-native', fingerprintOf(creds)]);
    return getPooled(cacheKey, creds.scope.guildId, () => new Anthropic({
        apiKey: creds.apiKey?.reveal() ?? '',
        baseURL: 'https://api.anthropic.com',
    }));
}

/** The Claude 5 models (Sonnet, Fable) use adaptive thinking and do not support `temperature`. */
function supportsTemperature(model: string): boolean {
    return !model.startsWith('claude-sonnet-5') && !model.startsWith('claude-fable-5');
}

/**
 * Anthropic offers no OpenAI-compatible endpoint (unlike Gemini, which has both
 * an OpenAI-compatible bridge and a native SDK): the only way to talk to Claude is
 * the native SDK/Messages API. That is why, unlike `shouldUseGeminiNative` (which
 * required an opt-in via env var), this function is always true for the 'anthropic' provider.
 */
export function shouldUseAnthropicNative(provider: string): boolean {
    return provider === 'anthropic';
}

/**
 * Anthropic "light" model for the high-volume / low-complexity phases
 * (bio batches, validation, query generation). Override via env `ANTHROPIC_LIGHT_MODEL`.
 */
export const ANTHROPIC_LIGHT_MODEL = process.env.ANTHROPIC_LIGHT_MODEL || 'claude-haiku-4-5';

const DEFAULT_MAX_TOKENS = 4096;

// Retry classification shared with geminiNativeGenerate.ts (see llm/retry.ts).
export { isRetryableNetworkError as isRetryableAnthropicError } from './llm/retry';
import { isRetryableNetworkError } from './llm/retry';

async function generateNative(params: {
    name: string;
    creds: ResolvedCredentials;
    model: string;
    systemInstruction: string;
    prompt: string;
    json: boolean;
    maxOutputTokens?: number;
    temperature?: number;
    reasoningEffort?: 'low' | 'medium' | 'high';
}): Promise<AnthropicNativeGenerateResult> {
    const start = Date.now();
    let response: Anthropic.Message | undefined;
    let lastError: any;

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const createParams: any = {
                model: params.model,
                max_tokens: params.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
                system: params.systemInstruction,
                messages: [{ role: 'user', content: params.prompt }]
            };
            if (supportsTemperature(params.model)) {
                createParams.temperature = params.temperature ?? 0;
            }
            // Optional cost/quality lever (default undefined = today's behaviour,
            // "high"): it should be set by call sites only for simple classification/extraction
            // tasks (see reasoningEffort in agent/runtime.ts for the full rationale).
            if (params.reasoningEffort) {
                createParams.output_config = { effort: params.reasoningEffort };
            }
            response = await getAnthropicAi(params.creds).messages.create(createParams);
            lastError = null;
            break;
        } catch (error: any) {
            lastError = error;
            if (!isRetryableNetworkError(error)) throw error;
            const waitMs = attempt * 2500;
            console.warn(`[AnthropicNative:${params.name}] ⚠️ ${params.model} fallito (${error?.status || error?.code || 'unknown'}); retry ${attempt}/2 tra ${waitMs}ms`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
    }

    if (lastError) throw lastError;
    if (!response) {
        throw new Error(`[AnthropicNative:${params.name}] Nessuna risposta da ${params.model}`);
    }

    const content = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('');
    const usage = response.usage;

    return {
        content,
        parsed: params.json ? safeJsonParse(content) : undefined,
        usage: {
            input: usage?.input_tokens || 0,
            output: usage?.output_tokens || 0,
            total: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
            cached: (usage as any)?.cache_read_input_tokens || 0
        },
        latency: Date.now() - start
    };
}

export async function generateAnthropicNativeJson<T = any>(params: {
    name: string;
    creds: ResolvedCredentials;
    model: string;
    systemInstruction: string;
    prompt: string;
    maxOutputTokens?: number;
    temperature?: number;
    reasoningEffort?: 'low' | 'medium' | 'high';
}): Promise<AnthropicNativeGenerateResult<T>> {
    const result = await generateNative({ ...params, json: true });
    return result as AnthropicNativeGenerateResult<T>;
}

export async function generateAnthropicNativeText(params: {
    name: string;
    creds: ResolvedCredentials;
    model: string;
    systemInstruction: string;
    prompt: string;
    maxOutputTokens?: number;
    temperature?: number;
    reasoningEffort?: 'low' | 'medium' | 'high';
}): Promise<AnthropicNativeGenerateResult<string>> {
    return generateNative({ ...params, json: false }) as Promise<AnthropicNativeGenerateResult<string>>;
}
