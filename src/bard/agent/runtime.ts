import OpenAI from 'openai';
import { safeJsonParse } from '../helpers';
import { AIProvider, loadAiConfig } from '../../config';
import type { ResolvedCredentials } from '../ai/types';
import { checkOllamaAlive, stripV1Suffix } from '../config';
import { runGeminiNativeAgent } from './geminiNative';
import { runAnthropicNativeAgent } from './anthropicNative';
import { toFullyRequiredJsonSchema } from './outputSchemas';

// Provider billed per-token via a remote API key (Gemini, OpenAI, Anthropic, Ollama's
// hosted cloud inference) vs. local/free compute ('ollama' only). Used to route to the
// monolithic prompt + limited native tools instead of the fragmented multi-call loop
// meant for VRAM-constrained local models — fragmenting a paid provider's Analyst call
// would multiply real API cost (roughly 4x-25x per session, see
// docs/agentic-local-rag-loop-status.md design notes), so every paid provider must be
// covered here, not just the ones exercised so far.
export function isPaidCloudProvider(provider: AIProvider): boolean {
    return provider === 'gemini' || provider === 'ollama-cloud' || provider === 'openai' || provider === 'anthropic';
}

/**
 * OpenAI "reasoning" models (o-series, gpt-5.x) — through Chat Completions they reject
 * tool-calling with a 400 unless reasoning_effort:'none' is set explicitly
 * (real error: "Function tools with reasoning_effort are not supported [...] in
 * /v1/chat/completions"). Non-reasoning models (gpt-4o and earlier) do not
 * recognize this parameter: it must be sent ONLY for reasoning models.
 */
function isOpenAIReasoningModel(model: string): boolean {
    return /^(o\d(-|$)|gpt-5)/.test(model);
}


export interface AgentTool {
    name: string;
    description: string;
    parameters: Record<string, string>;
    run(args: Record<string, any>): Promise<any>;
}

export interface AgentRunOptions {
    name: string;
    client: OpenAI;
    model: string;
    provider: AIProvider;
    /**
     * The table's credentials. Mandatory: the native agentic paths used to
     * build their own client from an environment singleton, and that is where
     * everyone's spend would have silently landed on the operator.
     */
    creds: ResolvedCredentials;
    systemPrompt: string;
    userPrompt: string;
    tools: AgentTool[];
    maxTurns: number;
    jsonMode?: boolean;
    /** JSON Schema for Anthropic Structured Outputs (output_config.format).
     *  When set and provider is 'anthropic', forces valid JSON matching this schema. */
    outputSchema?: Record<string, any>;
    /** Generic, provider-agnostic reasoning/cost lever (the call sites do not
     *  know which provider is configured for their phase, given that they rotate among the 4).
     *  Translated into thinking_level for Gemini, output_config.effort for Anthropic;
     *  ignored by OpenAI/Ollama/Ollama Cloud (no reasoning model in use today). */
    reasoningEffort?: 'low' | 'medium' | 'high';
    numCtx?: number;
    requireToolUse?: boolean;
    requiredTools?: string[];
    unloadAfter?: boolean;
    maxToolCalls?: number;
}

export interface AgentRunResult {
    output: any | null;
    transcript: any[];
    turns: number;
    usage: {
        input: number;
        output: number;
        inputChars: number;
        outputChars: number;
        /** Token serviti da cache (Anthropic: cache_read_input_tokens; Gemini: da verificare). */
        cached?: number;
    };
}

function buildNativeTools(tools: AgentTool[]): any[] {
    return tools.map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: {
                type: 'object',
                properties: Object.fromEntries(
                    Object.entries(tool.parameters).map(([name, description]) => [
                        name,
                        { type: 'string', description }
                    ])
                ),
                required: Object.keys(tool.parameters).filter(name => !['limit', 'chars'].includes(name)),
                additionalProperties: false
            }
        }
    }));
}

async function getOllamaNativeBaseUrl(): Promise<string> {
    // loadAiConfig is cached internally: calling it again here costs nothing.
    const cfg = loadAiConfig();
    const override = process.env.OLLAMA_NATIVE_BASE_URL;
    if (override) return stripV1Suffix(override).replace(/\/$/, '');

    for (const url of [cfg.ollama.remoteUrl, cfg.ollama.localUrl]) {
        const baseUrl = stripV1Suffix(url).replace(/\/$/, '');
        if (await checkOllamaAlive(baseUrl)) return baseUrl;
    }

    return stripV1Suffix(cfg.ollama.remoteUrl).replace(/\/$/, '');
}

function sanitizeOllamaMessages(messages: any[]): any[] {
    return messages.map(message => {
        if (message.role === 'tool') {
            return {
                role: 'tool',
                content: message.content || '',
                ...(message.tool_name ? { tool_name: message.tool_name } : {})
            };
        }
        if (message.role === 'assistant') {
            return {
                role: 'assistant',
                content: message.content || '',
                ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {})
            };
        }
        return { role: message.role, content: message.content || '' };
    });
}

async function createOllamaNativeChatCompletion(model: string, messages: any[], tools: any[], numCtx?: number, format?: string | Record<string, any>): Promise<any> {
    const baseUrl = await getOllamaNativeBaseUrl();
    const body: any = {
        model,
        messages: sanitizeOllamaMessages(messages),
        tools,
        stream: false,
        options: {
            temperature: 0,
            num_ctx: numCtx || 32768
        }
    };
    if (format) {
        body.format = format;
    }
    const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });

    const text = await response.text();
    if (!response.ok) {
        throw new Error(`Ollama native chat HTTP ${response.status}: ${text}`);
    }

    const json = safeJsonParse(text);
    const message = json?.message || {};
    return {
        choices: [{ message }],
        usage: {
            prompt_tokens: json?.prompt_eval_count || 0,
            completion_tokens: json?.eval_count || 0
        }
    };
}

async function unloadOllamaModel(model: string): Promise<void> {
    const cfg = loadAiConfig();
    const urls = [...new Set([cfg.ollama.remoteUrl, cfg.ollama.localUrl])]
        .map(stripV1Suffix);

    for (const baseUrl of urls) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            await fetch(`${baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: 0 }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
        } catch {
            // Best effort: an unload must not fail the pipeline.
        }
    }
}

export async function unloadAgentModel(model: string): Promise<void> {
    await unloadOllamaModel(model);
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
    // Gemini and Anthropic always use their respective native SDKs: uniform flows,
    // no opt-in via env var (the old AGENTIC_GEMINI_NATIVE_API has been removed).
    if (options.provider === 'gemini') {
        return runGeminiNativeAgent(options);
    }
    if (options.provider === 'anthropic') {
        return runAnthropicNativeAgent(options);
    }

    const toolsByName = new Map(options.tools.map(tool => [tool.name, tool]));
    const transcript: any[] = [
        { role: 'system', content: options.systemPrompt },
        { role: 'user', content: options.userPrompt }
    ];
    const usage = { input: 0, output: 0, inputChars: options.systemPrompt.length + options.userPrompt.length, outputChars: 0 };
    let usedTool = false;
    const usedTools = new Set<string>();
    let toolCallCount = 0;
    const nativeTools = buildNativeTools(options.tools);
    const useOllamaNativeApi = options.provider === 'ollama' && process.env.AGENTIC_OLLAMA_NATIVE_API !== 'false';
    const isCloudLegacyProvider = isPaidCloudProvider(options.provider);
    const effectiveMaxToolCalls = isCloudLegacyProvider
        ? parseInt(process.env.AGENTIC_GEMINI_MAX_TOOL_CALLS || String(options.maxToolCalls || 3), 10)
        : options.maxToolCalls;
    let finalWithoutTools = false;

    for (let turn = 0; turn < options.maxTurns; turn++) {
        const activeTools = finalWithoutTools ? [] : nativeTools;
        const requestOptions: any = {
            model: options.model,
            messages: transcript
        };

        if (activeTools.length > 0) {
            requestOptions.tools = activeTools;
            requestOptions.tool_choice = options.requireToolUse && !usedTool ? 'required' : 'auto';
            if (options.provider === 'openai' && isOpenAIReasoningModel(options.model)) {
                requestOptions.reasoning_effort = 'none';
            }
        }

        if (options.provider === 'openai' && options.jsonMode) {
            if (options.outputSchema) {
                // Structured Outputs: JSON Schema + strict mode (gpt-4o-2024-08-06+).
                // Replaces the old json_object, which only guaranteed valid JSON,
                // not adherence to the schema.
                requestOptions.response_format = {
                    type: 'json_schema',
                    json_schema: {
                        name: 'output',
                        strict: true,
                        schema: toFullyRequiredJsonSchema(options.outputSchema)
                    }
                };
            } else {
                // Fall back to the old JSON mode for calls without a schema.
                requestOptions.response_format = { type: 'json_object' };
            }
        } else if (options.provider === 'ollama') {
            requestOptions.options = { num_ctx: options.numCtx || 32768 };
            // Structured Outputs: when no tools are active, the model
            // has to produce the final answer. We pass the full JSON schema
            // rather than the plain "json" string to guarantee adherence.
            if (options.jsonMode && activeTools.length === 0) {
                requestOptions.format = options.outputSchema || 'json';
            }
        } else if (options.provider === 'ollama-cloud' && options.jsonMode) {
            // Ollama Cloud does not support structured outputs (schema-constrained):
            // https://docs.ollama.com/capabilities/structured-outputs — unlike
            // local Ollama, options.outputSchema must NEVER be passed here as format,
            // only plain JSON mode.
            requestOptions.format = 'json';
        }

        let response: any;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                response = useOllamaNativeApi
                    ? await createOllamaNativeChatCompletion(options.model, transcript, activeTools, options.numCtx, requestOptions.format)
                    : await options.client.chat.completions.create(requestOptions);
                break;
            } catch (error: any) {
                const status = error?.status || error?.code;
                const retryable = status === 429 || (typeof status === 'number' && status >= 500);
                if (!retryable || attempt === 3) throw error;
                const waitMs = attempt * 3000;
                console.warn(`[Agent:${options.name}] ⚠️ chiamata modello fallita (${status}); retry ${attempt}/3 tra ${waitMs}ms`);
                await new Promise(resolve => setTimeout(resolve, waitMs));
            }
        }
        const message = response.choices?.[0]?.message || {};
        const content = message.content || '';
        const toolCalls = message.tool_calls || [];

        transcript.push({
            role: 'assistant',
            content,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {})
        });

        usage.input += response.usage?.prompt_tokens || 0;
        usage.output += response.usage?.completion_tokens || 0;
        usage.outputChars += content.length;

        if (toolCalls.length > 0) {
            if (effectiveMaxToolCalls && toolCallCount >= effectiveMaxToolCalls) {
                finalWithoutTools = true;
                transcript.push({
                    role: 'user',
                    content: 'Hai gia usato abbastanza tool. Ora restituisci il JSON finale usando solo le evidenze raccolte.'
                });
                continue;
            }
            for (const call of toolCalls) {
                if (effectiveMaxToolCalls && toolCallCount >= effectiveMaxToolCalls) {
                    finalWithoutTools = true;
                    // Every tool_call_id MUST have a matching response, even when it was
                    // not executed (hard OpenAI constraint: "An assistant message with
                    // 'tool_calls' must be followed by tool messages responding to each
                    // tool_call_id" — a `break` here left the last tool_calls of a
                    // parallel batch unanswered, a 400 on every following turn).
                    // Same pattern already used in agent/anthropicNative.ts for the same case.
                    transcript.push({
                        role: 'tool',
                        tool_call_id: call.id,
                        tool_name: call.function?.name,
                        content: JSON.stringify({ error: 'Budget di tool call esaurito per questo turno.' })
                    });
                    continue;
                }
                const name = call.function?.name;
                const tool = toolsByName.get(name);
                let args: Record<string, any> = {};
                try {
                    args = safeJsonParse(call.function?.arguments || '{}') || {};
                } catch {
                    args = {};
                }
                console.log(`[Agent:${options.name}] 🔧 tool_call ${name} ${JSON.stringify(args).substring(0, 500)}`);

                if (!tool) {
                    transcript.push({
                        role: 'tool',
                        tool_call_id: call.id,
                        tool_name: name,
                        content: JSON.stringify({ error: `Tool non consentito o inesistente: ${name}` })
                    });
                    continue;
                }

                try {
                    const result = await tool.run(args);
                    usedTool = true;
                    usedTools.add(name);
                    toolCallCount++;
                    const resultText = JSON.stringify(result);
                    console.log(`[Agent:${options.name}] ✅ tool_result ${name} ${resultText.length} chars`);
                    const defaultToolResultChars = isCloudLegacyProvider
                        ? (process.env.AGENTIC_GEMINI_TOOL_RESULT_CHARS || '2500')
                        : '4000';
                    const maxToolResultChars = parseInt(process.env.AGENTIC_TOOL_RESULT_CHARS || defaultToolResultChars, 10);
                    transcript.push({
                        role: 'tool',
                        tool_call_id: call.id,
                        tool_name: name,
                        content: resultText.substring(0, maxToolResultChars)
                    });
                } catch (error: any) {
                    console.warn(`[Agent:${options.name}] ⚠️ tool_error ${name}: ${error?.message || String(error)}`);
                    transcript.push({
                        role: 'tool',
                        tool_call_id: call.id,
                        tool_name: name,
                        content: JSON.stringify({ error: error?.message || String(error) })
                    });
                }
            }
            continue;
        }

        const parsed = safeJsonParse(content);
        if (!parsed || typeof parsed !== 'object') {
            transcript.push({
                role: 'user',
                content: 'La risposta finale deve essere JSON strettamente valido: niente markdown, niente trailing comma, niente numeri con segno + (usa 5, non +5). Riprova restituendo solo JSON.'
            });
            continue;
        }

        if (parsed.action === 'final') {
            if (options.requireToolUse && !usedTool) {
                transcript.push({
                    role: 'user',
                    content: 'Prima del JSON finale devi usare almeno un tool nativo per raccogliere evidenze.'
                });
                continue;
            }
            const missingTools = (options.requiredTools || []).filter(toolName => !usedTools.has(toolName));
            if (missingTools.length > 0) {
                transcript.push({
                    role: 'user',
                    content: `Prima del JSON finale devi usare questi tool nativi mancanti: ${missingTools.join(', ')}.`
                });
                continue;
            }
            if (options.provider === 'ollama' && (options.unloadAfter || process.env.OLLAMA_UNLOAD_AFTER_AGENT === 'true')) {
                await unloadOllamaModel(options.model);
            }
            return {
                output: parsed.output || {},
                transcript,
                turns: turn + 1,
                usage
            };
        }

        if (!parsed.action) {
            if (options.requireToolUse && !usedTool) {
                transcript.push({
                    role: 'user',
                    content: 'Hai prodotto il JSON finale senza usare tool. Prima usa almeno un tool nativo, poi restituisci il JSON finale.'
                });
                continue;
            }
            const missingTools = (options.requiredTools || []).filter(toolName => !usedTools.has(toolName));
            if (missingTools.length > 0) {
                transcript.push({
                    role: 'user',
                    content: `Prima del JSON finale devi usare questi tool nativi mancanti: ${missingTools.join(', ')}.`
                });
                continue;
            }
            if (options.provider === 'ollama' && (options.unloadAfter || process.env.OLLAMA_UNLOAD_AFTER_AGENT === 'true')) {
                await unloadOllamaModel(options.model);
            }
            return {
                output: parsed,
                transcript,
                turns: turn + 1,
                usage
            };
        }

        if (parsed.action !== 'tool' || typeof parsed.tool !== 'string') {
            transcript.push({
                role: 'user',
                content: 'Azione non valida. Usa tool calling nativo oppure restituisci direttamente il JSON finale.'
            });
            continue;
        }

        const tool = toolsByName.get(parsed.tool);
        if (!tool) {
            transcript.push({
                role: 'user',
                content: JSON.stringify({ tool: parsed.tool, error: 'Tool non consentito o inesistente.' })
            });
            continue;
        }

        try {
            const result = await tool.run(parsed.args || {});
            usedTool = true;
            transcript.push({
                role: 'user',
                content: JSON.stringify({
                    tool: parsed.tool,
                    result
                }).substring(0, 12000)
            });
        } catch (error: any) {
            transcript.push({
                role: 'user',
                content: JSON.stringify({
                    tool: parsed.tool,
                    error: error?.message || String(error)
                })
            });
        }
    }

    if (options.provider === 'ollama' && (options.unloadAfter || process.env.OLLAMA_UNLOAD_AFTER_AGENT === 'true')) {
        await unloadOllamaModel(options.model);
    }

    return {
        output: null,
        transcript,
        turns: options.maxTurns,
        usage
    };
}
