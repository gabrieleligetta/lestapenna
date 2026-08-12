/**
 * Single dispatcher for LLM generation.
 *
 * The providers speak three different "transports":
 *  - OpenAI-compatible SDK: openai, ollama, ollama-cloud
 *  - native @google/genai SDK: always, for the gemini provider
 *  - native @anthropic-ai/sdk SDK: always, for the anthropic provider
 *
 * This 3-way dispatch used to be copy-pasted across ~16 call sites, with
 * inconsistent coverage (some phases crashed when configured on anthropic, and
 * ollama-cloud did not get JSON mode everywhere). Here it lives ONCE, together
 * with the token/latency bookkeeping and the cost log towards the monitor.
 *
 * Typical use:
 *   const r = await generateJson<MyShape>({
 *       route: await getMetadataClient(),
 *       label: 'metadata',
 *       system: '...', prompt: '...',
 *   });
 */

import OpenAI from 'openai';
import { AIProvider } from '../../config';
import { monitor } from '../../monitor';
import { safeJsonParse } from '../helpers';
import {
    shouldUseGeminiNative,
    resolveLightModel,
    generateGeminiNativeJson,
    generateGeminiNativeText,
} from '../geminiNativeGenerate';
import {
    shouldUseAnthropicNative,
    generateAnthropicNativeJson,
    generateAnthropicNativeText,
} from '../anthropicNativeGenerate';
import type { AiScope, ResolvedCredentials } from '../ai/types';
import { classifyProviderError, redactKeyLike } from '../ai/providerErrors';
import { flagCredential } from '../ai/credentials';

/**
 * Resolved route for a phase: where to call, with which model and — above all —
 * **with which credential**.
 *
 * `creds` and `scope` are mandatory and deliberately have no default. The keys
 * used to be read once at startup into module singletons: under BYOK that
 * design would make the operator pay for every table's calls, and the failure
 * would be silent — the UI would say "I am using your key" while the bill
 * arrives at ours. Making the field mandatory means every point that builds or
 * consumes a route has to declare it, and the compiler is what finds them.
 */
export interface ProviderRoute {
    client: OpenAI;
    model: string;
    provider: AIProvider;
    creds: ResolvedCredentials;
    scope: AiScope;
}

export interface GenerateParams {
    /** Route resolved by the phase getter in bard/config.ts. */
    route: ProviderRoute;
    /** Cost phase for monitor.logAIRequestWithCost (e.g. 'metadata', 'summary'). */
    label: string;
    system: string;
    prompt: string;
    /**
     * Optional conversational history (chat/RAG). On the compat transport it
     * becomes real messages between system and prompt; on the native SDKs (a single
     * prompt) it is flattened at the head of the prompt.
     */
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    /** When omitted the provider uses its own default (like the old call sites). */
    temperature?: number;
    /** Mappato su max_completion_tokens (compat) / maxOutputTokens (nativi). */
    maxTokens?: number;
    /**
     * A limit applied ONLY to the native SDKs (gemini/anthropic). It serves the
     * historical call sites that did not limit the OpenAI-compatible path.
     * When present alongside maxTokens, this one wins on the native paths.
     */
    maxTokensNative?: number;
    /**
     * High-volume/low-complexity phases: on the native providers (gemini,
     * anthropic) it uses the "light" model (resolveLightModel), on the others it
     * keeps the phase model.
     */
    lightModel?: boolean;
    /**
     * Extra parameters passed as they are to the OpenAI-compatible transport only
     * (e.g. `{ options: { num_ctx: 8192 } }` for Ollama). Ignored by the native ones.
     */
    compatOptions?: Record<string, any>;
    /**
     * Generic, provider-agnostic reasoning/cost lever (the call site does not know
     * which provider is configured for its phase, given that they rotate among the 4).
     * Translated into thinkingConfig.thinkingLevel for Gemini, output_config.effort for
     * Anthropic; ignored on openai/ollama/ollama-cloud (no reasoning model in use
     * today). Default undefined = today's behaviour ("high").
     */
    reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface LlmResult<T = any> {
    content: string;
    /** Present only for generateJson: the output of safeJsonParse (null when unparsable). */
    parsed?: T | null;
    provider: AIProvider;
    /** The model actually used (after any resolveLightModel). */
    model: string;
    usage: { input: number; output: number; cached: number };
    latencyMs: number;
}

async function generate<T>(params: GenerateParams, json: boolean): Promise<LlmResult<T>> {
    try {
        return await dispatch<T>(params, json);
    } catch (error) {
        // The single point every LLM call goes through: this is where a dry or
        // revoked key becomes visible data in the table's settings. No provider
        // exposes the remaining balance, so the rejection of a real call is the
        // only reliable signal we have.
        const classified = classifyProviderError(params.route.provider, error);
        if (classified.kind === 'QUOTA_EXHAUSTED' || classified.kind === 'AUTH_FAILED') {
            // The provider's message may contain the key itself.
            flagCredential(params.route.creds, classified.kind, redactKeyLike(classified.raw));
        }
        // We rethrow the ORIGINAL error: the retry logic upstream looks at
        // `status`/`code`, and replacing it with a type of ours would switch it off.
        throw error;
    }
}

async function dispatch<T>(params: GenerateParams, json: boolean): Promise<LlmResult<T>> {
    const { client, model, provider, creds } = params.route;
    const start = Date.now();

    const isNative = shouldUseGeminiNative(provider) || shouldUseAnthropicNative(provider);
    const effectiveModel = (isNative && params.lightModel)
        ? resolveLightModel(provider, model)
        : model;

    let result: LlmResult<T>;

    if (shouldUseGeminiNative(provider) || shouldUseAnthropicNative(provider)) {
        const nativeFn = shouldUseGeminiNative(provider)
            ? (json ? generateGeminiNativeJson : generateGeminiNativeText)
            : (json ? generateAnthropicNativeJson : generateAnthropicNativeText);

        const nativePrompt = params.history?.length
            ? `CRONOLOGIA CONVERSAZIONE:\n${params.history.map(m => `${m.role}: ${m.content}`).join('\n')}\n\n${params.prompt}`
            : params.prompt;

        const native = await nativeFn({
            name: params.label,
            // The table's credentials, not the instance's: the native SDKs
            // used to have a module singleton, and that is the point where spend
            // would silently land on the operator.
            creds,
            model: effectiveModel,
            systemInstruction: params.system,
            prompt: nativePrompt,
            maxOutputTokens: params.maxTokensNative ?? params.maxTokens,
            ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
            ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
        });

        result = {
            content: native.content,
            ...(json ? { parsed: native.parsed as T | null } : {}),
            provider,
            model: effectiveModel,
            usage: { input: native.usage.input, output: native.usage.output, cached: native.usage.cached || 0 },
            latencyMs: native.latency,
        };
    } else {
        const options: any = {
            model: effectiveModel,
            messages: [
                { role: 'system', content: params.system },
                ...(params.history || []),
                { role: 'user', content: params.prompt },
            ],
        };
        // OpenAI reasoning models (o-series, gpt-5.x) accept only temperature=1
        // (the default): any explicit value, including 0, is rejected with a 400
        // "Unsupported value: 'temperature' does not support 0 with this model" —
        // verified via a real API error on gpt-5.6-terra (reconciliation/semantic.ts,
        // which passes an explicit temperature:0). Ollama/ollama-cloud do not have this
        // restriction, so the check only applies to provider==='openai'.
        const skipTemperature = provider === 'openai' && /^(o\d(-|$)|gpt-5)/.test(effectiveModel);
        if (params.temperature !== undefined && !skipTemperature) options.temperature = params.temperature;
        if (params.maxTokens !== undefined) options.max_completion_tokens = params.maxTokens;
        if (json) {
            // JSON mode per provider (gemini/anthropic never come through here:
            // they always go to their respective native SDKs).
            if (provider === 'openai') options.response_format = { type: 'json_object' };
            else if (provider === 'ollama' || provider === 'ollama-cloud') options.format = 'json';
        }
        if (params.compatOptions) Object.assign(options, params.compatOptions);

        const response = await client.chat.completions.create(options);
        const content = response.choices?.[0]?.message?.content || (json ? '{}' : '');

        result = {
            content,
            ...(json ? { parsed: (safeJsonParse(content) as T | null) } : {}),
            provider,
            model: effectiveModel,
            usage: {
                input: response.usage?.prompt_tokens || 0,
                output: response.usage?.completion_tokens || 0,
                cached: response.usage?.prompt_tokens_details?.cached_tokens || 0,
            },
            latencyMs: Date.now() - start,
        };
    }

    monitor.logAIRequestWithCost(
        params.label, provider, effectiveModel,
        result.usage.input, result.usage.output, result.usage.cached,
        result.latencyMs, false
    );
    return result;
}

/** Generation with JSON output (parsed through safeJsonParse into `parsed`). */
export function generateJson<T = any>(params: GenerateParams): Promise<LlmResult<T>> {
    return generate<T>(params, true);
}

/** Generation with free-form text output. */
export function generateText(params: GenerateParams): Promise<LlmResult<string>> {
    return generate<string>(params, false);
}
