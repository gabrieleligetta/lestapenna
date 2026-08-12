import { GoogleGenAI } from '@google/genai';
import { safeJsonParse } from './helpers';
import { getPooled, poolCacheKey } from './ai/clientPool';
import { fingerprintOf } from './ai/providerFactory';
import type { ResolvedCredentials } from './ai/types';
import { ANTHROPIC_LIGHT_MODEL } from './anthropicNativeGenerate';

export interface GeminiNativeGenerateResult<T = any> {
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
 * Native Gemini client for the given credentials.
 *
 * It used to be a module singleton initialized with the environment key: under
 * BYOK it would have kept charging the operator while the UI claimed to be using
 * the table's key. It now goes through the pool, keyed on the credential's
 * fingerprint — never on its value.
 *
 * Exported because transcription and image generation need the same client and
 * had — or would have had — their own byte-identical copy. Every copy is another
 * place where `reveal()` is called, and that set is asserted by
 * `tests/unit/services/secretExposure.test.ts`: keeping it at one is the point.
 */
export function getGeminiAi(creds: ResolvedCredentials): GoogleGenAI {
    const cacheKey = poolCacheKey(['gemini-native', fingerprintOf(creds)]);
    return getPooled(cacheKey, creds.scope.guildId, () => new GoogleGenAI({
        apiKey: creds.apiKey?.reveal() ?? '',
    }));
}

/**
 * Gemini ALWAYS uses the native @google/genai SDK, like Anthropic: Google's
 * OpenAI-compatible bridge is no longer used for generation.
 * (The old AGENTIC_GEMINI_NATIVE_API opt-in was removed to make the flows uniform.)
 */
export function shouldUseGeminiNative(provider: string): boolean {
    return provider === 'gemini';
}

/**
 * "Light" model for the high-volume / low-complexity phases
 * (bio batches, validation, query generation, preliminary scout).
 * Override via env `LIGHT_PHASE_MODEL` (gemini) / `ANTHROPIC_LIGHT_MODEL` (anthropic).
 * For openai/ollama the phase's configured model is kept.
 */
export const GEMINI_LIGHT_MODEL = process.env.LIGHT_PHASE_MODEL || 'gemini-3.1-flash-lite';

export function resolveLightModel(provider: string, configuredModel: string): string {
    if (provider === 'gemini') return GEMINI_LIGHT_MODEL;
    if (provider === 'anthropic') return ANTHROPIC_LIGHT_MODEL;
    return configuredModel;
}

// Retry classification shared with anthropicNativeGenerate.ts (see llm/retry.ts).
export { isRetryableNetworkError as isRetryableGeminiError } from './llm/retry';
import { isRetryableNetworkError } from './llm/retry';

export function geminiModelFallbackChain(primaryModel: string): string[] {
    const configured = (process.env.AGENTIC_GEMINI_MODEL_FALLBACKS || 'gemini-3-flash-preview,gemini-3.1-flash-lite')
        .split(',')
        .map(model => model.trim())
        .filter(Boolean);
    return [...new Set([primaryModel, ...configured])];
}

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
}): Promise<GeminiNativeGenerateResult> {
    const start = Date.now();
    let response: any;
    let lastError: any;

    for (const model of geminiModelFallbackChain(params.model)) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                response = await getGeminiAi(params.creds).models.generateContent({
                    model,
                    contents: params.prompt,
                    config: {
                        systemInstruction: params.systemInstruction,
                        temperature: params.temperature ?? 0,
                        maxOutputTokens: params.maxOutputTokens,
                        ...(params.json ? { responseMimeType: 'application/json' } : {}),
                        // Optional cost/quality lever (default undefined = today's
                        // behaviour for gemini-3-*-preview, thinkingLevel "high"): it should be set
                        // by call sites only for simple classification/extraction tasks.
                        // The shape was verified against the real type declarations of the installed SDK
                        // (node_modules/@google/genai): ThinkingConfig.thinkingLevel.
                        ...(params.reasoningEffort ? { thinkingConfig: { thinkingLevel: params.reasoningEffort } } : {})
                    } as any
                } as any);
                if (model !== params.model) {
                    console.warn(`[GeminiNative:${params.name}] ✅ fallback model attivo: ${params.model} → ${model}`);
                }
                lastError = null;
                break;
            } catch (error: any) {
                lastError = error;
                if (!isRetryableNetworkError(error)) throw error;
                const waitMs = attempt * 2500;
                console.warn(`[GeminiNative:${params.name}] ⚠️ ${model} fallito (${error?.status || error?.code || 'unknown'}); retry ${attempt}/2 tra ${waitMs}ms`);
                await new Promise(resolve => setTimeout(resolve, waitMs));
            }
        }
        if (!lastError) break;
        console.warn(`[GeminiNative:${params.name}] 🔁 failover modello dopo errori: ${model}`);
    }

    if (lastError) {
        throw lastError;
    }
    if (!response) {
        throw new Error(`[GeminiNative:${params.name}] Nessuna risposta Gemini da ${geminiModelFallbackChain(params.model).join(', ')}`);
    }

    const content = response?.text || '';
    const usage = response?.usageMetadata || {};
    return {
        content,
        parsed: params.json ? safeJsonParse(content) : undefined,
        usage: {
            input: usage.promptTokenCount || 0,
            output: usage.candidatesTokenCount || 0,
            total: usage.totalTokenCount || ((usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0)),
            // The field was verified against the SDK's real type declarations (GenerateContentResponseUsageMetadata.cachedContentTokenCount).
            cached: (usage as any).cachedContentTokenCount || 0
        },
        latency: Date.now() - start
    };
}

export async function generateGeminiNativeJson<T = any>(params: {
    name: string;
    creds: ResolvedCredentials;
    model: string;
    systemInstruction: string;
    prompt: string;
    maxOutputTokens?: number;
    temperature?: number;
    reasoningEffort?: 'low' | 'medium' | 'high';
}): Promise<GeminiNativeGenerateResult<T>> {
    const result = await generateNative({ ...params, json: true });
    return result as GeminiNativeGenerateResult<T>;
}

export async function generateGeminiNativeText(params: {
    name: string;
    creds: ResolvedCredentials;
    model: string;
    systemInstruction: string;
    prompt: string;
    maxOutputTokens?: number;
    temperature?: number;
    reasoningEffort?: 'low' | 'medium' | 'high';
}): Promise<GeminiNativeGenerateResult<string>> {
    return generateNative({ ...params, json: false }) as Promise<GeminiNativeGenerateResult<string>>;
}
