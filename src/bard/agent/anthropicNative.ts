import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import { safeJsonParse } from '../helpers';
import { isRetryableAnthropicError } from '../anthropicNativeGenerate';
import { toFullyRequiredJsonSchema } from './outputSchemas';

/** The Claude 5 models (Sonnet, Fable) use adaptive thinking and do not support `temperature`. */
function supportsTemperature(model: string): boolean {
    return !model.startsWith('claude-sonnet-5') && !model.startsWith('claude-fable-5');
}

/**
 * Claude Sonnet 5/Fable 5 have adaptive thinking ON BY DEFAULT (no `thinking`
 * field to set in order to enable it). Official docs (platform.claude.com,
 * tool-use guide): "tool_choice: any/tool ... not supported [with extended thinking]
 * and will result in an error" — here we use `tool_choice: any` every time
 * requireToolUse forces the turn (see below). Thinking must be disabled explicitly
 * only on those turns, not on the one with tool_choice:auto (final answer),
 * where adaptive thinking can still help quality.
 */
function usesAdaptiveThinkingByDefault(model: string): boolean {
    return model.startsWith('claude-sonnet-5') || model.startsWith('claude-fable-5');
}
import type { AgentRunOptions, AgentRunResult, AgentTool } from './runtime';
import { getPooled, poolCacheKey } from '../ai/clientPool';
import { fingerprintOf } from '../ai/providerFactory';
import type { ResolvedCredentials } from '../ai/types';

const DEFAULT_MAX_TOKENS = 16384;

/** The table's Anthropic client, from the pool: never an environment singleton. */
function getAnthropicAi(creds: ResolvedCredentials): Anthropic {
    const cacheKey = poolCacheKey(['anthropic-agent', fingerprintOf(creds)]);
    return getPooled(cacheKey, creds.scope.guildId, () => new Anthropic({
        apiKey: creds.apiKey?.reveal() ?? '',
        baseURL: 'https://api.anthropic.com',
    }));
}

function buildAnthropicTools(tools: AgentTool[]): Anthropic.Tool[] {
    return tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: {
            type: 'object',
            properties: Object.fromEntries(
                Object.entries(tool.parameters).map(([name, description]) => [
                    name,
                    { type: 'string', description }
                ])
            ),
            required: Object.keys(tool.parameters).filter(name => !['limit', 'chars'].includes(name))
        }
    }));
}

/**
 * Native agentic tool-calling loop for Claude, mirroring runGeminiNativeAgent
 * (./geminiNative.ts) but on Anthropic's Messages API — which, unlike the
 * OpenAI-compatible bridge and the Gemini SDK, is stateless: every call has to resend the
 * whole `messages` array, and every `tool_use` block MUST receive a matching `tool_result`
 * in the immediately following `user` message (tool_results must come first in the
 * content array, any text after) — a format constraint verified on
 * platform.claude.com/docs, not deducible by analogy from Gemini/OpenAI.
 */
export async function runAnthropicNativeAgent(options: AgentRunOptions): Promise<AgentRunResult> {
    const toolsByName = new Map(options.tools.map(tool => [tool.name, tool]));
    const anthropicTools = buildAnthropicTools(options.tools);
    const usage = {
        input: 0,
        output: 0,
        inputChars: options.systemPrompt.length + options.userPrompt.length,
        outputChars: 0,
        cached: 0
    };

    const messages: Anthropic.MessageParam[] = [
        { role: 'user', content: options.userPrompt }
    ];
    // A "flat" transcript for logging/debug only, in the same shape used by the other providers.
    const transcript: any[] = [
        { role: 'system', content: options.systemPrompt },
        { role: 'user', content: options.userPrompt }
    ];

    const ai = getAnthropicAi(options.creds);
    let usedTool = false;
    const usedTools = new Set<string>();
    let toolCallCount = 0;
    const maxToolCalls = parseInt(process.env.AGENTIC_ANTHROPIC_MAX_TOOL_CALLS || String(options.maxToolCalls || 3), 10);
    const maxToolResultChars = parseInt(process.env.AGENTIC_ANTHROPIC_TOOL_RESULT_CHARS || process.env.AGENTIC_TOOL_RESULT_CHARS || '2500', 10);

    for (let turn = 0; turn < options.maxTurns; turn++) {
        const toolChoice: Anthropic.ToolChoice = (!usedTool && options.requireToolUse)
            ? { type: 'any' }
            : { type: 'auto' };

        let response: Anthropic.Message | undefined;
        let lastError: any;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const createParams: any = {
                    model: options.model,
                    max_tokens: DEFAULT_MAX_TOKENS,
                    // Prompt caching: the systemPrompt (which often includes the WORLD MANIFESTO,
                    // typically above the 1024-token minimum cacheable threshold) is identical
                    // on every turn of THIS multi-turn call — additive and safe, below
                    // the threshold the API simply does not cache, no error.
                    system: [
                        { type: 'text', text: options.systemPrompt, cache_control: { type: 'ephemeral' } }
                    ],
                    messages,
                    tools: anthropicTools,
                    tool_choice: toolChoice
                };
                if (supportsTemperature(options.model)) {
                    createParams.temperature = 0;
                }
                if (toolChoice.type !== 'auto' && usesAdaptiveThinkingByDefault(options.model)) {
                    createParams.thinking = { type: 'disabled' };
                }
                const outputConfig: Record<string, any> = {};
                // Structured Outputs: forces valid JSON via a schema (equivalent to
                // OpenAI's response_format, but validated against a precise schema).
                if (options.jsonMode && options.outputSchema) {
                    // toFullyRequiredJsonSchema reduces the "optionals" (Anthropic limit: 24),
                    // but it is NOT enough for ANALYST_OUTPUT_SCHEMA: the same transformation
                    // blows the "union-typed" parameters past the SEPARATE limit of 16 —
                    // the two limits conflict for this schema, and no transformation
                    // satisfies both (verified with real API errors on 2026-07-12,
                    // see outputSchemas.ts and agentic-model-tests/LEADERBOARD.md). That is why
                    // Claude Sonnet 5/Anthropic is excluded as an Analyst provider: the call
                    // below will fail with a 400 until ANALYST_OUTPUT_SCHEMA is split
                    // into smaller schemas. It stays valid for WRITER_OUTPUT_SCHEMA (few
                    // properties, well under both limits).
                    outputConfig.format = { type: 'json_schema', schema: toFullyRequiredJsonSchema(options.outputSchema) };
                }
                // Cost/quality lever: not set by default (undefined = today's
                // behaviour, "high"). It should be applied by call sites only for simple
                // classification/extraction tasks, never for Analyst/Writer (see runtime.ts).
                if (options.reasoningEffort) {
                    outputConfig.effort = options.reasoningEffort;
                }
                if (Object.keys(outputConfig).length > 0) {
                    createParams.output_config = outputConfig;
                }
                response = await ai.messages.create(createParams);
                lastError = null;
                break;
            } catch (error: any) {
                lastError = error;
                if (!isRetryableAnthropicError(error)) throw error;
                const waitMs = attempt * 3000;
                console.warn(`[Agent:${options.name}] ⚠️ chiamata Claude fallita (${error?.status || error?.code || 'unknown'}); retry ${attempt}/2 tra ${waitMs}ms`);
                await new Promise(resolve => setTimeout(resolve, waitMs));
            }
        }
        if (lastError) throw lastError;
        if (!response) {
            throw new Error(`[Agent:${options.name}] Nessuna risposta da Claude (${options.model})`);
        }

        usage.input += response.usage?.input_tokens || 0;
        usage.output += response.usage?.output_tokens || 0;
        usage.cached += (response.usage as any)?.cache_read_input_tokens || 0;

        const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
        const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        const content = textBlocks.map(b => b.text).join('');
        usage.outputChars += content.length;

        // The whole content array (text + tool_use) has to be echoed back as it is in
        // the history, not just the text: Claude needs it for the following turn.
        messages.push({ role: 'assistant', content: response.content as any });

        transcript.push({
            role: 'assistant',
            content,
            ...(toolUseBlocks.length ? {
                tool_calls: toolUseBlocks.map(b => ({
                    id: b.id,
                    type: 'function',
                    function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
                }))
            } : {})
        });

        if (response.stop_reason === 'tool_use' && toolUseBlocks.length > 0) {
            const resultBlocks: Anthropic.ToolResultBlockParam[] = [];

            for (const block of toolUseBlocks) {
                const name = block.name;
                const args = (block.input || {}) as Record<string, any>;

                if (toolCallCount >= maxToolCalls) {
                    // Every tool_use MUST have a matching tool_result, even when it was not executed.
                    resultBlocks.push({ type: 'tool_result', tool_use_id: block.id, content: 'Budget di tool esaurito per questo turno.', is_error: true });
                    continue;
                }

                const tool = toolsByName.get(name);
                console.log(`[Agent:${options.name}] 🔧 anthropic_tool_call ${name} ${JSON.stringify(args).substring(0, 500)}`);

                if (!tool) {
                    resultBlocks.push({ type: 'tool_result', tool_use_id: block.id, content: `Tool non consentito o inesistente: ${name}`, is_error: true });
                    continue;
                }

                try {
                    const result = await tool.run(args);
                    usedTool = true;
                    usedTools.add(name);
                    toolCallCount++;
                    const fullResultText = JSON.stringify(result);
                    const truncated = fullResultText.length > maxToolResultChars;
                    const resultText = truncated ? fullResultText.substring(0, maxToolResultChars) : fullResultText;
                    console.log(`[Agent:${options.name}] ✅ anthropic_tool_result ${name} ${fullResultText.length} chars`);
                    resultBlocks.push({ type: 'tool_result', tool_use_id: block.id, content: resultText });
                    transcript.push({ role: 'tool', tool_name: name, content: resultText });
                } catch (error: any) {
                    console.warn(`[Agent:${options.name}] ⚠️ anthropic_tool_error ${name}: ${error?.message || String(error)}`);
                    resultBlocks.push({ type: 'tool_result', tool_use_id: block.id, content: error?.message || String(error), is_error: true });
                }
            }

            const userContent: Anthropic.ContentBlockParam[] = [...resultBlocks];
            if (toolCallCount >= maxToolCalls) {
                userContent.push({ type: 'text', text: 'Hai gia usato abbastanza tool. Ora restituisci solo il JSON finale valido usando le evidenze raccolte.' });
            }
            messages.push({ role: 'user', content: userContent });
            continue;
        }

        const parsed = safeJsonParse(content);
        if (!parsed || typeof parsed !== 'object') {
            messages.push({ role: 'user', content: 'La risposta finale deve essere JSON strettamente valido: niente markdown. Riprova restituendo solo JSON.' });
            continue;
        }

        if (parsed.action === 'final') {
            if (options.requireToolUse && !usedTool) {
                messages.push({ role: 'user', content: 'Prima del JSON finale devi usare almeno un tool nativo per raccogliere evidenze.' });
                continue;
            }
            const missingTools = (options.requiredTools || []).filter(toolName => !usedTools.has(toolName));
            if (missingTools.length > 0) {
                messages.push({ role: 'user', content: `Prima del JSON finale devi usare questi tool nativi mancanti: ${missingTools.join(', ')}.` });
                continue;
            }
            return { output: parsed.output || {}, transcript, turns: turn + 1, usage };
        }

        const missingTools = (options.requiredTools || []).filter(toolName => !usedTools.has(toolName));
        if (missingTools.length > 0) {
            messages.push({ role: 'user', content: `Prima del JSON finale devi usare questi tool nativi mancanti: ${missingTools.join(', ')}.` });
            continue;
        }

        return { output: parsed, transcript, turns: turn + 1, usage };
    }

    return { output: null, transcript, turns: options.maxTurns, usage };
}
