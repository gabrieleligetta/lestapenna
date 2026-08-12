import { FunctionCallingConfigMode, GoogleGenAI, type FunctionDeclaration, type Part } from '@google/genai';
import { config } from '../../config';
import { safeJsonParse } from '../helpers';
import { geminiModelFallbackChain, isRetryableGeminiError } from '../geminiNativeGenerate';
import type { AgentRunOptions, AgentRunResult, AgentTool } from './runtime';
import { getPooled, poolCacheKey } from '../ai/clientPool';
import { fingerprintOf } from '../ai/providerFactory';
import type { ResolvedCredentials } from '../ai/types';

/** The table's Gemini client, from the pool: never an environment singleton. */
function getGeminiAgentClient(creds: ResolvedCredentials): GoogleGenAI {
    const cacheKey = poolCacheKey(['gemini-agent', fingerprintOf(creds)]);
    return getPooled(cacheKey, creds.scope.guildId, () => new GoogleGenAI({
        apiKey: creds.apiKey?.reveal() ?? '',
    }));
}

function buildFunctionDeclarations(tools: AgentTool[]): FunctionDeclaration[] {
    return tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: {
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
    }));
}

function resultToPart(name: string, id: string | undefined, result: any, maxChars: number): Part {
    const fullResultText = JSON.stringify(result);
    const truncated = fullResultText.length > maxChars;
    const resultText = truncated ? fullResultText.substring(0, maxChars) : fullResultText;
    return {
        functionResponse: {
            id,
            name,
            response: { output: truncated ? resultText : (safeJsonParse(resultText) || resultText) }
        } as any
    };
}

function createGeminiAgentChat(
    ai: GoogleGenAI,
    model: string,
    options: AgentRunOptions,
    functionDeclarations: FunctionDeclaration[]
): any {
    const config: any = {
        systemInstruction: options.systemPrompt,
        temperature: 0,
        tools: [{ functionDeclarations }],
        toolConfig: {
            functionCallingConfig: {
                mode: options.requireToolUse ? FunctionCallingConfigMode.ANY : FunctionCallingConfigMode.AUTO
            }
        }
    };

    // Structured Outputs: forces valid JSON via a schema (equivalent to
    // OpenAI's response_format, but validated against a precise schema).
    // Requires Gemini 3 series models (gemini-3.x) to work with tools.
    // NEVER together with functionCallingConfig.mode ANY: the Gemini API rejects with a 400
    // "Forced function calling (ANY mode) with a response mime type: 'application/json'
    // is unsupported" — so the schema has to be omitted while tool use is forced
    // (mode ANY above, when requireToolUse is true), the same turn on which it would
    // otherwise be applied alongside. It also holds at creation: turn 1 will have mode ANY
    // if requireToolUse is true (usedTool always starts false).
    if (options.jsonMode && options.outputSchema && !options.requireToolUse) {
        config.responseJsonSchema = options.outputSchema;
        config.responseMimeType = 'application/json';
    }

    // Optional cost/quality lever (default undefined = today's behaviour,
    // thinkingLevel "high"): deliberately not set here for Analyst/Writer
    // (complex reasoning, it needs empirical validation before being lowered).
    if (options.reasoningEffort) {
        config.thinkingConfig = { thinkingLevel: options.reasoningEffort };
    }

    return ai.chats.create({ model, config });
}

function serializeMessageForFailover(message: string | Part[]): string {
    if (typeof message === 'string') return message;
    return JSON.stringify(message).substring(0, 12000);
}

function transcriptForFailover(transcript: any[]): string {
    return transcript.slice(-14).map(entry => {
        if (entry.role === 'tool') {
            return `TOOL ${entry.tool_name}: ${entry.content || ''}`;
        }
        if (entry.tool_calls) {
            return `${entry.role}: ${entry.content || ''}\nTOOL_CALLS: ${JSON.stringify(entry.tool_calls).substring(0, 3000)}`;
        }
        return `${entry.role}: ${entry.content || ''}`;
    }).join('\n\n').substring(0, 24000);
}

export async function runGeminiNativeAgent(options: AgentRunOptions): Promise<AgentRunResult> {
    const toolsByName = new Map(options.tools.map(tool => [tool.name, tool]));
    const functionDeclarations = buildFunctionDeclarations(options.tools);
    const usage = {
        input: 0,
        output: 0,
        inputChars: options.systemPrompt.length + options.userPrompt.length,
        outputChars: 0,
        cached: 0
    };
    const transcript: any[] = [
        { role: 'system', content: options.systemPrompt },
        { role: 'user', content: options.userPrompt }
    ];
    const ai = getGeminiAgentClient(options.creds);
    const models = geminiModelFallbackChain(options.model);
    let activeModelIndex = 0;
    let activeModel = models[activeModelIndex];
    let chat = createGeminiAgentChat(ai, activeModel, options, functionDeclarations);

    let usedTool = false;
    const usedTools = new Set<string>();
    let toolCallCount = 0;
    const maxToolCalls = parseInt(process.env.AGENTIC_GEMINI_MAX_TOOL_CALLS || String(options.maxToolCalls || 3), 10);
    const maxToolResultChars = parseInt(process.env.AGENTIC_GEMINI_TOOL_RESULT_CHARS || process.env.AGENTIC_TOOL_RESULT_CHARS || '2500', 10);
    let nextMessage: string | Part[] = options.userPrompt;

    for (let turn = 0; turn < options.maxTurns; turn++) {
        const mode = !usedTool && options.requireToolUse
            ? FunctionCallingConfigMode.ANY
            : FunctionCallingConfigMode.AUTO;
        let response: any;
        let lastError: any;
        let sendMessage = nextMessage;

        while (!response) {
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    const sendConfig: any = {
                        temperature: 0,
                        tools: [{ functionDeclarations }],
                        toolConfig: { functionCallingConfig: { mode } }
                    };
                    // We restate the schema in the per-message config too: the config
                    // of sendMessage could override the one set when the chat was
                    // created. NEVER together with mode ANY (see the comment in
                    // createGeminiAgentChat) — only when tool use is no longer forced,
                    // that is, on the turn when the model can really give the final answer.
                    if (options.jsonMode && options.outputSchema && mode !== FunctionCallingConfigMode.ANY) {
                        sendConfig.responseJsonSchema = options.outputSchema;
                        sendConfig.responseMimeType = 'application/json';
                    }
                    if (options.reasoningEffort) {
                        sendConfig.thinkingConfig = { thinkingLevel: options.reasoningEffort };
                    }
                    response = await chat.sendMessage({
                        message: sendMessage,
                        config: sendConfig
                    });
                    if (activeModel !== options.model) {
                        console.warn(`[Agent:${options.name}] ✅ fallback model attivo: ${options.model} → ${activeModel}`);
                    }
                    lastError = null;
                    break;
                } catch (error: any) {
                    lastError = error;
                    if (!isRetryableGeminiError(error)) throw error;
                    const waitMs = attempt * 3000;
                    console.warn(`[Agent:${options.name}] ⚠️ ${activeModel} call fallita (${error?.status || error?.code || 'unknown'}); retry ${attempt}/2 tra ${waitMs}ms`);
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                }
            }

            if (response) break;
            if (activeModelIndex >= models.length - 1) {
                throw lastError;
            }

            const previousModel = activeModel;
            activeModelIndex++;
            activeModel = models[activeModelIndex];
            chat = createGeminiAgentChat(ai, activeModel, options, functionDeclarations);
            sendMessage = `Il modello precedente (${previousModel}) ha fallito per errore temporaneo. Continua questa sessione agentica usando il transcript compatto e produci il prossimo passo coerente.

TRANSCRIPT COMPATTO:
${transcriptForFailover(transcript)}

MESSAGGIO PENDENTE:
${serializeMessageForFailover(nextMessage)}`;
            console.warn(`[Agent:${options.name}] 🔁 failover modello Gemini: ${previousModel} → ${activeModel}`);
        }
        const content = response.text || '';
        const functionCalls = response.functionCalls || [];
        usage.input += response.usageMetadata?.promptTokenCount || 0;
        usage.output += response.usageMetadata?.candidatesTokenCount || 0;
        usage.cached += response.usageMetadata?.cachedContentTokenCount || 0;
        usage.outputChars += content.length;

        transcript.push({
            role: 'assistant',
            content,
            ...(functionCalls.length ? {
                tool_calls: functionCalls.map((call: any) => ({
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.args || {}) }
                }))
            } : {})
        });

        if (functionCalls.length > 0) {
            const parts: Part[] = [];
            for (const call of functionCalls) {
                if (toolCallCount >= maxToolCalls) break;
                const name = call.name || '';
                const tool = toolsByName.get(name);
                const args = (call.args || {}) as Record<string, any>;
                console.log(`[Agent:${options.name}] 🔧 gemini_tool_call ${name} ${JSON.stringify(args).substring(0, 500)}`);

                if (!tool) {
                    parts.push(resultToPart(name, call.id, { error: `Tool non consentito o inesistente: ${name}` }, maxToolResultChars));
                    continue;
                }

                try {
                    const result = await tool.run(args);
                    usedTool = true;
                    usedTools.add(name);
                    toolCallCount++;
                    const resultText = JSON.stringify(result);
                    console.log(`[Agent:${options.name}] ✅ gemini_tool_result ${name} ${resultText.length} chars`);
                    parts.push(resultToPart(name, call.id, result, maxToolResultChars));
                    transcript.push({
                        role: 'tool',
                        tool_name: name,
                        content: resultText.substring(0, maxToolResultChars)
                    });
                } catch (error: any) {
                    console.warn(`[Agent:${options.name}] ⚠️ gemini_tool_error ${name}: ${error?.message || String(error)}`);
                    parts.push(resultToPart(name, call.id, { error: error?.message || String(error) }, maxToolResultChars));
                }
            }

            if (parts.length > 0 && toolCallCount < maxToolCalls) {
                nextMessage = parts;
                continue;
            }

            nextMessage = `Hai gia usato abbastanza tool. Ora restituisci solo il JSON finale valido usando le evidenze raccolte.`;
            continue;
        }

        const parsed = safeJsonParse(content);
        if (!parsed || typeof parsed !== 'object') {
            nextMessage = 'La risposta finale deve essere JSON strettamente valido: niente markdown. Riprova restituendo solo JSON.';
            continue;
        }

        if (parsed.action === 'final') {
            if (options.requireToolUse && !usedTool) {
                nextMessage = 'Prima del JSON finale devi usare almeno un tool nativo per raccogliere evidenze.';
                continue;
            }
            return { output: parsed.output || {}, transcript, turns: turn + 1, usage };
        }

        const missingTools = (options.requiredTools || []).filter(toolName => !usedTools.has(toolName));
        if (missingTools.length > 0) {
            nextMessage = `Prima del JSON finale devi usare questi tool nativi mancanti: ${missingTools.join(', ')}.`;
            continue;
        }

        return { output: parsed, transcript, turns: turn + 1, usage };
    }

    return { output: null, transcript, turns: options.maxTurns, usage };
}
