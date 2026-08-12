import { getAnalystClient, getSummaryClient } from '../config';
import { AnalystOutput, ToneKey } from '../types';
import { ANALYST_PROMPT, WRITER_BARDO_PROMPT, WRITER_DM_PROMPT } from '../prompts';
import { runAgent, unloadAgentModel, isPaidCloudProvider } from './runtime';
import { createAgentTools } from './tools';
import { SessionRagIndex } from './sessionRag';
import { AIProvider } from '../../config';
import { ANALYST_OUTPUT_SCHEMA, WRITER_OUTPUT_SCHEMA } from './outputSchemas';
import { aiOutputDirective, getCampaignLocale } from '../../i18n';
import { normalizeMonsterList } from '../monsterContract';

// Paid providers behind an API key (Gemini, OpenAI, Ollama cloud, etc.): a monolithic
// prompt + limited native tools, instead of the fragmented loop designed for
// local models constrained by the remote PC's VRAM — see isPaidCloudProvider
// in ./runtime for the reason (cost, not just VRAM/context).
function isCloudLegacyProvider(provider: AIProvider): boolean {
    return isPaidCloudProvider(provider);
}

export interface AgentTokens {
    input: number;
    output: number;
    inputChars: number;
    outputChars: number;
    cached?: number;
}

export interface AnalystAgentInput {
    campaignId: number;
    sessionId: string;
    narrativeText: string;
    castContext: string;
    memoryContext: string;
    atlasContext: string;
    partContext?: string;
    manifesto?: string;
}

export interface WriterAgentInput {
    campaignId: number;
    sessionId: string;
    tone: ToneKey;
    actNumber: number;
    totalActs: number;
    narrativeText: string;
    castContext: string;
    memoryContext: string;
    analystData: AnalystOutput;
    manifesto?: string;
}

type AnalystFragment = {
    key: string;
    buildPrompt: (chunk: string, stateBrief: string) => string;
    maxTurns: number;
    requiredTools: string[];
};

const AGENTIC_ANALYST_CHUNK_CHARS = parseInt(process.env.AGENTIC_ANALYST_CHUNK_CHARS || '30000', 10);
const AGENTIC_ANALYST_CHUNK_OVERLAP = parseInt(process.env.AGENTIC_ANALYST_CHUNK_OVERLAP || '1800', 10);

function splitForLocalContext(text: string, chunkSize: number = AGENTIC_ANALYST_CHUNK_CHARS, overlap: number = AGENTIC_ANALYST_CHUNK_OVERLAP): string[] {
    if (text.length <= chunkSize) return [text];
    const chunks: string[] = [];
    let cursor = 0;
    while (cursor < text.length) {
        let end = Math.min(cursor + chunkSize, text.length);
        if (end < text.length) {
            const breakAt = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf('.', end));
            if (breakAt > cursor + Math.floor(chunkSize * 0.65)) end = breakAt + 1;
        }
        chunks.push(text.substring(cursor, end));
        if (end >= text.length) break;
        cursor = Math.max(end - overlap, cursor + 1);
    }
    return chunks;
}

function compactText(value: string, maxChars: number): string {
    if (!value || value.length <= maxChars) return value || '';
    const head = value.substring(0, Math.floor(maxChars * 0.35));
    const tail = value.substring(value.length - Math.floor(maxChars * 0.65));
    return `${head}\n\n[...compacted context...]\n\n${tail}`;
}

function emptyAnalystOutput(): AnalystOutput {
    return {
        loot: [], loot_removed: [], quests: [], monsters: [],
        npc_dossier_updates: [], location_updates: [], travel_sequence: [], present_npcs: [], npc_locations: [],
        log: [], character_growth: [], npc_events: [], world_events: [],
        faction_updates: [], faction_affiliations: [], artifacts: [], artifact_events: []
    };
}

function cleanName(value: any): string {
    return String(value || '').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
}

function arrayOf(value: any): any[] {
    return Array.isArray(value) ? value : [];
}

function normalizeFragmentOutput(raw: any): Partial<AnalystOutput> {
    const data = raw?.output && typeof raw.output === 'object' ? raw.output : raw;
    if (!data || typeof data !== 'object') return {};

    return {
        loot: arrayOf(data.loot).filter((x: any) => x?.name),
        loot_removed: arrayOf(data.loot_removed).filter((x: any) => x?.name),
        quests: arrayOf(data.quests).filter((x: any) => x?.title),
        monsters: normalizeMonsterList(data.monsters),
        npc_dossier_updates: arrayOf(data.npc_dossier_updates)
            .map((x: any) => ({ ...x, name: cleanName(x?.name) }))
            .filter((x: any) => x.name && x.description),
        location_updates: arrayOf(data.location_updates).filter((x: any) => x?.macro && x?.micro),
        travel_sequence: arrayOf(data.travel_sequence).filter((x: any) => x?.macro && x?.micro),
        present_npcs: arrayOf(data.present_npcs).map(cleanName).filter(Boolean),
        npc_locations: arrayOf(data.npc_locations)
            .map((x: any) => ({ ...x, name: cleanName(x?.name) }))
            .filter((x: any) => x.name && (x.location_id || (x.macro && x.micro))),
        log: arrayOf(data.log).map((x: any) => String(x || '').trim()).filter(Boolean),
        character_growth: arrayOf(data.character_growth).filter((x: any) => x?.name && x?.event),
        npc_events: arrayOf(data.npc_events)
            .map((x: any) => ({ ...x, name: cleanName(x?.name) }))
            .filter((x: any) => x.name && x.event),
        world_events: arrayOf(data.world_events).filter((x: any) => x?.event),
        faction_updates: arrayOf(data.faction_updates).filter((x: any) => x?.name),
        faction_affiliations: arrayOf(data.faction_affiliations).filter((x: any) => x?.entity_name && x?.faction_name),
        party_alignment_change: data.party_alignment_change?.reason ? data.party_alignment_change : undefined,
        artifacts: arrayOf(data.artifacts).filter((x: any) => x?.name),
        artifact_events: arrayOf(data.artifact_events).filter((x: any) => x?.name && x?.event)
    };
}

function appendUniqueByText<T>(target: T[], values: T[], keyFn: (value: T) => string): void {
    const seen = new Set(target.map(keyFn));
    for (const value of values || []) {
        const key = keyFn(value);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        target.push(value);
    }
}

function mergeAnalystData(target: AnalystOutput, patch: Partial<AnalystOutput>): AnalystOutput {
    appendUniqueByText(target.loot, patch.loot || [], (x: any) => `${cleanName(x.name).toLowerCase()}|${x.description || ''}`);
    appendUniqueByText(target.loot_removed, patch.loot_removed || [], (x: any) => `${cleanName(x.name).toLowerCase()}|${x.description || ''}`);
    appendUniqueByText(target.quests, patch.quests || [], (x: any) => `${String(x.title || '').toLowerCase()}|${x.status || ''}|${x.description || ''}`);
    appendUniqueByText(target.monsters, patch.monsters || [], (x: any) => `${cleanName(x.name).toLowerCase()}|${x.status || ''}`);
    appendUniqueByText(target.npc_dossier_updates, patch.npc_dossier_updates || [], (x: any) => `${cleanName(x.name).toLowerCase()}|${x.description || ''}`);
    appendUniqueByText(target.location_updates, patch.location_updates || [], (x: any) => `${x.macro}|${x.micro}|${x.description || ''}`.toLowerCase());
    appendUniqueByText(target.travel_sequence, patch.travel_sequence || [], (x: any) => `${x.macro}|${x.micro}|${x.reason || ''}`.toLowerCase());
    appendUniqueByText(target.present_npcs, patch.present_npcs || [], (x: any) => cleanName(x).toLowerCase());
    appendUniqueByText(target.log, patch.log || [], (x: any) => String(x || '').toLowerCase());
    appendUniqueByText(target.character_growth, patch.character_growth || [], (x: any) => `${cleanName(x.name).toLowerCase()}|${x.event || ''}`);
    appendUniqueByText(target.npc_events, patch.npc_events || [], (x: any) => `${cleanName(x.name).toLowerCase()}|${x.event || ''}|${x.type || ''}`);
    appendUniqueByText(target.world_events, patch.world_events || [], (x: any) => `${x.event || ''}|${x.type || ''}`.toLowerCase());
    appendUniqueByText(target.faction_updates, patch.faction_updates || [], (x: any) => `${cleanName(x.name).toLowerCase()}|${x.description || ''}|${x.reputation_change?.reason || ''}`);
    appendUniqueByText(target.faction_affiliations, patch.faction_affiliations || [], (x: any) => `${x.entity_type}|${cleanName(x.entity_name).toLowerCase()}|${cleanName(x.faction_name).toLowerCase()}|${x.action}`);
    appendUniqueByText(target.artifacts, patch.artifacts || [], (x: any) => `${cleanName(x.name).toLowerCase()}|${x.status || ''}|${x.description || ''}`);
    appendUniqueByText(target.artifact_events, patch.artifact_events || [], (x: any) => `${cleanName(x.name).toLowerCase()}|${x.event || ''}|${x.type || ''}`);

    for (const loc of patch.npc_locations || []) {
        const idx = target.npc_locations.findIndex(existing => cleanName(existing.name).toLowerCase() === cleanName(loc.name).toLowerCase());
        if (idx >= 0) target.npc_locations[idx] = loc;
        else target.npc_locations.push(loc);
    }

    if (patch.party_alignment_change?.reason) {
        target.party_alignment_change = patch.party_alignment_change;
    }

    return target;
}

function hasAnalystSignal(data: Partial<AnalystOutput>): boolean {
    return [
        data.loot, data.loot_removed, data.quests, data.monsters, data.npc_dossier_updates,
        data.location_updates, data.travel_sequence, data.present_npcs, data.npc_locations,
        data.log, data.character_growth, data.npc_events, data.world_events, data.faction_updates,
        data.faction_affiliations, data.artifacts, data.artifact_events
    ].some(value => Array.isArray(value) && value.length > 0) || Boolean(data.party_alignment_change?.reason);
}

function accumulatorBrief(data: AnalystOutput): string {
    const names = (values: any[], key: string = 'name') => values.map(v => cleanName(v?.[key] ?? v)).filter(Boolean);
    return JSON.stringify({
        present_npcs: names(data.present_npcs).slice(-20),
        quests: names(data.quests, 'title').slice(-10),
        npc_events: data.npc_events.length,
        character_growth: data.character_growth.length,
        world_events: data.world_events.length,
        loot: names(data.loot).slice(-10),
        monsters: names(data.monsters).slice(-10),
        factions: names(data.faction_updates).slice(-10),
        artifacts: names(data.artifacts).slice(-10),
        travel_sequence: data.travel_sequence.slice(-8),
        log: data.log.slice(-8)
    }, null, 2);
}

function finalSchemaReminder(): string {
    return `Return directly a valid JSON object with these keys: loot, loot_removed, quests, monsters, npc_dossier_updates, location_updates, travel_sequence, present_npcs, npc_locations, log, character_growth, npc_events, world_events, faction_updates, faction_affiliations, party_alignment_change, artifacts, artifact_events. Use empty arrays for missing data. Do not use markdown.`;
}

function agenticLegacyAnalystPrompt(castContext: string, memoryContext: string, narrativeText: string, atlasContext: string): string {
    return `${ANALYST_PROMPT(castContext, memoryContext, narrativeText, atlasContext)}

## AGENTIC INSTRUCTIONS
Before the final JSON, use at least one native tool to verify evidence or identities:
- first use search_session_rag or list_transcript_mentions with concrete names/items/quests from the text;
- use get_transcript_window when you need the full context around a scene;
- use find_entities to validate NPCs, locations, quests, items, factions and artifacts;
- use get_entity_history/get_npc_dossier only for already-known or ambiguous entities;
- use search_historical_rag/search_manifesto only if historical context is needed.
Tool budget: few targeted calls, maximum quality. Do not call generic tools if the text is already explicit.
After gathering evidence, return ONLY the legacy JSON required by the prompt above.

## MANDATORY FINAL CHECKLIST (anti-omission)
Before emitting the JSON, re-scan the text and explicitly verify these often-forgotten fields. Do NOT invent: include only what the text supports, but do NOT omit what is there.
- loot_removed: include items CONSUMED, USED, LOST, SPENT or GIVEN AWAY (not only found ones). Potions drunk, arrows/ammo used, items donated or stolen from the party.
- faction_updates: for EVERY faction the party interacts with (help, alliance, insult, attack, betrayal) create an entry WITH reputation_change, including HOSTILE/negative actions (negative value). Do not leave reputation_change empty if there was a relevant action.
- artifacts: every magic/legendary/unique item with a PROPER NAME or described as significant goes in artifacts (not just the most striking ones).
- artifact_events: for each artifact create event entries even at low intensity: OBSERVATION (the artifact reacts/pulses), REVELATION (a property is discovered), ACTIVATION, TRANSFER, DISCOVERY.
- character_growth: BINDING RULE — EVERY CAST PC must have AT LEAST ONE event, even minor (observation, decision, reaction). No cast PC can be left without an entry.
- npc_locations: for each NPC in present_npcs whose observable physical place the text shows, emit their LAST seen position (respect the NOTICE: never stamp everyone on the party's last location).`;
}

function agenticLegacyWriterPrompt(input: WriterAgentInput, analystJson: string): string {
    const base = input.tone === 'DM'
        ? WRITER_DM_PROMPT(input.castContext, input.memoryContext, analystJson)
        : WRITER_BARDO_PROMPT(input.tone, input.castContext, input.memoryContext, analystJson);

    const partNote = input.totalActs > 1
        ? `\n\n[NOTE FOR THE AI: This is PART ${input.actNumber} of ${input.totalActs}. ${input.actNumber > 1 ? 'Continue consistently with the previous parts.' : 'Set the initial tone and context.'}]`
        : '';

    return `${base}

${partNote}

TRANSCRIPT PART ${input.actNumber}:
${input.narrativeText}

## AGENTIC INSTRUCTIONS
Before the final JSON, use at least one native tool to verify continuity or details:
- get_transcript_window/search_session_rag for specific scenes;
- search_manifesto/search_historical_rag/get_entity_history for historical consistency.
Then return ONLY the legacy JSON required by the Writer prompt.`;
}

function analystTask(kind: string, castContext: string, memoryContext: string, atlasContext: string, overview: string, candidateNames: string, stateBrief: string): string {
    const shared = `## COMPACT CONTEXT
${castContext}

## COMPACT DYNAMIC MEMORY
${memoryContext}

## COMPACT ATLAS
${atlasContext}

## CURRENT TRANSCRIPT OVERVIEW
${overview}

## DETERMINISTIC PROPER-NAME CANDIDATES
${candidateNames}

## STATE ACCUMULATED SO FAR
${stateBrief}

Use the native tools to retrieve targeted evidence from the transcript, the manifesto, the DB and the historical RAG. You do not need to read the whole transcript in the prompt: overview and candidates are already below.
Tool strategy: you must call native tools before the final JSON. Prefer search_session_rag, list_transcript_mentions, get_transcript_window and find_entities with concrete names/terms from the candidate list. Use resolve_entity only as a secondary cleanup step if needed.

Mandatory first strategy:
1. start from the overview/candidates included in the prompt;
2. query list_transcript_mentions/search_session_rag using names or places that emerged from the candidates, not invented hypothetical phrases;
3. validate ambiguous entities with find_entities; if still ambiguous use resolve_entity;
4. after a few good proofs, finalize.`;

    if (kind === 'presence') {
        return `${shared}

## TASK
Extract ONLY NPC presence, NPC positions, place sequence and location_updates.
Critical rules:
- present_npcs: only physically present NPCs that speak/act, not cast PCs and not merely mentioned ones.
- npc_locations: last observed physical position of each NPC in the current text; do not assign a default place to everyone.
- If a place exists in the atlas use canonical location_id/macro/micro; otherwise macro/micro consistent with travel_sequence.
${finalSchemaReminder()}`;
    }

    if (kind === 'events') {
        return `${shared}

## TASK
Extract ONLY NPC events, dossier updates, PC growth, world_events and party_alignment_change.
Rules:
- Every new NPC that acts must have FIRST_APPEARANCE.
- Every cast PC must have at least one character_growth if they acted/suffered/discovered something in this part.
- Moral/ethical impacts -10..+10; neutral = 0.
- party_alignment_change only if the group's choice truly changes the moral/ethical profile.
${finalSchemaReminder()}`;
    }

    if (kind === 'items') {
        return `${shared}

## TASK
Extract ONLY loot, loot_removed, quests, monsters, artifacts, artifact_events, faction_updates and faction_affiliations.
Rules:
- Loot only items obtained now; loot_removed only items lost/used now.
- Monsters only hostile creatures fought now.
- Quest enum contract is exact: status = OPEN | IN_PROGRESS | COMPLETED | FAILED; type = MAJOR | MINOR. Never translate or invent enum values.
- Factions: do not attribute reputation_change to the party's own faction as a self-referential subject; use the external faction whose reputation changes.
${finalSchemaReminder()}`;
    }

    return `${shared}

## TASK
Produce ONLY a chronological technical log for the DM: "[Place] Who -> Action -> Result".
Answer directly with JSON: {"log":[...]} without markdown.`;
}

export async function runAnalystAgent(input: AnalystAgentInput): Promise<{ data: any | null; tokens: AgentTokens; debug: string; provider: AIProvider; model: string }> {
    // The extracted texts (events, descriptions) end up in the DB: campaign language.
    const langDirective = aiOutputDirective(getCampaignLocale(input.campaignId));
    const effectiveText = input.partContext ? `[[${input.partContext}]]\n\n${input.narrativeText}` : input.narrativeText;
    const sessionRag = new SessionRagIndex(effectiveText);
    const tools = createAgentTools(input.campaignId, sessionRag, input.manifesto || '');
    const { client, model, provider, creds } = await getAnalystClient();

    if (isCloudLegacyProvider(provider) && process.env.AGENTIC_GEMINI_LEGACY_PROMPTS !== 'false') {
        console.log(`[Analista/Agent] ${provider}: uso prompt legacy monolitico + tool nativi.`);
        const result = await runAgent({
            name: `Analista:legacy-${provider}`,
            client,
            model,
            provider,
            creds,
            maxTurns: parseInt(process.env.AGENTIC_GEMINI_LEGACY_MAX_TURNS || '4', 10),
            jsonMode: true,
            outputSchema: ANALYST_OUTPUT_SCHEMA,
            tools,
            requireToolUse: true,
            requiredTools: [],
            maxToolCalls: parseInt(process.env.AGENTIC_GEMINI_MAX_TOOL_CALLS || '3', 10),
            systemPrompt: input.manifesto
                ? `You are a D&D data analyst. Use the WORLD MANIFESTO as global context, the native tools to verify evidence, and return only valid JSON.\n\nWORLD MANIFESTO:\n${input.manifesto}`
                : 'You are a D&D data analyst. Use native tools to verify evidence and return only valid JSON.',
            userPrompt: agenticLegacyAnalystPrompt(input.castContext, input.memoryContext, effectiveText, input.atlasContext) + langDirective
        });

        return {
            data: result.output,
            tokens: result.usage,
            debug: JSON.stringify(result.transcript, null, 2),
            provider,
            model
        };
    }

    if (provider === 'ollama' && process.env.AGENTIC_UNLOAD_BEFORE_PHASE !== 'false') {
        console.log(`[Analista/Agent] 🧹 Unload modello prima della fase: ${model}`);
        await unloadAgentModel(model);
    }
    const castContext = compactText(input.castContext, 5000);
    const memoryContext = compactText(input.memoryContext, 14000);
    const atlasContext = compactText(input.atlasContext, 12000);
    const chunks = splitForLocalContext(effectiveText);
    const aggregated = emptyAnalystOutput();
    const totalTokens: AgentTokens = { input: 0, output: 0, inputChars: 0, outputChars: 0 };
    const debug: any[] = [];

    const fragments: AnalystFragment[] = [
        {
            key: 'presence',
            maxTurns: 5,
            requiredTools: [],
            buildPrompt: (_chunk, stateBrief) => analystTask('presence', castContext, memoryContext, atlasContext, JSON.stringify(sessionRag.overview(), null, 2), JSON.stringify(sessionRag.candidateNames(80), null, 2), stateBrief)
        },
        {
            key: 'events',
            maxTurns: 5,
            requiredTools: [],
            buildPrompt: (_chunk, stateBrief) => analystTask('events', castContext, memoryContext, atlasContext, JSON.stringify(sessionRag.overview(), null, 2), JSON.stringify(sessionRag.candidateNames(80), null, 2), stateBrief)
        },
        {
            key: 'items',
            maxTurns: 5,
            requiredTools: [],
            buildPrompt: (_chunk, stateBrief) => analystTask('items', castContext, memoryContext, atlasContext, JSON.stringify(sessionRag.overview(), null, 2), JSON.stringify(sessionRag.candidateNames(80), null, 2), stateBrief)
        },
        {
            key: 'log',
            maxTurns: 4,
            requiredTools: [],
            buildPrompt: (_chunk, stateBrief) => analystTask('log', castContext, memoryContext, atlasContext, JSON.stringify(sessionRag.overview(), null, 2), JSON.stringify(sessionRag.candidateNames(80), null, 2), stateBrief)
        }
    ];

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        const chunkHeader = `Chunk ${chunkIndex + 1}/${chunks.length}${input.partContext ? ` - ${input.partContext}` : ''}`;
        console.log(`[Analista/Agent] ${chunkHeader}: ${chunk.length} chars, ${fragments.length} frammenti.`);

        for (const fragment of fragments) {
            const stateBrief = accumulatorBrief(aggregated);
            const result = await runAgent({
                name: `Analista:${fragment.key}`,
                client,
                model,
                provider,
                creds,
                maxTurns: fragment.maxTurns,
                jsonMode: true,
                outputSchema: ANALYST_OUTPUT_SCHEMA,
                numCtx: 32768,
                tools,
                requireToolUse: true,
                requiredTools: fragment.requiredTools,
                maxToolCalls: parseInt(process.env.AGENTIC_MAX_TOOL_CALLS || '8', 10),
                unloadAfter: process.env.AGENTIC_UNLOAD_BETWEEN_FRAGMENTS === 'true',
                systemPrompt: `You are a D&D data analyst. You use read-only native tools to retrieve evidence from the transcript, the DB, the historical RAG and the manifesto. Produce only valid final JSON. Do not invent: every relevant datum must be supported by tools or by the compact context.`,
                userPrompt: `${fragment.buildPrompt(chunk, stateBrief)}\n\nYou must call at least one native tool before the final JSON. For entity validation call find_entities with type/query; for transcript evidence call search_session_rag or list_transcript_mentions with concrete names from the candidate list.${langDirective}`
            });

            totalTokens.input += result.usage.input;
            totalTokens.output += result.usage.output;
            totalTokens.inputChars += result.usage.inputChars;
            totalTokens.outputChars += result.usage.outputChars;

            const normalized = normalizeFragmentOutput(result.output);
            mergeAnalystData(aggregated, normalized);
            debug.push({ chunk: chunkIndex + 1, fragment: fragment.key, output: result.output, transcript: result.transcript });
        }
    }

    if (process.env.AGENTIC_ANALYST_CONSOLIDATE !== 'false') {
        const aggregateJson = JSON.stringify(aggregated, null, 2);
        const result = await runAgent({
            name: 'Analista:consolidate',
            client,
            model,
            provider,
            creds,
            maxTurns: 5,
            jsonMode: true,
            outputSchema: ANALYST_OUTPUT_SCHEMA,
            numCtx: 32768,
            tools,
            requireToolUse: true,
            requiredTools: [],
            maxToolCalls: parseInt(process.env.AGENTIC_MAX_TOOL_CALLS || '8', 10),
            unloadAfter: process.env.AGENTIC_UNLOAD_AFTER_ANALYST === 'true',
            systemPrompt: `You are the D&D Analyst's final validator. You use native tools to compare partial extractions, DB/RAG, manifesto and current transcript. Do not invent: fix duplicates, dirty names, IDs and categories.`,
            userPrompt: `## AGGREGATED EXTRACTION TO VALIDATE\n${compactText(aggregateJson, 36000)}\n\n## INSTRUCTIONS\n- Use at least one native tool: search_session_rag/list_transcript_mentions to verify important events or find_entities/resolve_entity for entities.\n- Keep all relevant metadata already extracted, but remove obvious duplicates and names with roles in parentheses.\n- If you find important omissions in the transcript/RAG, add them.\n${finalSchemaReminder()}${langDirective}`
        });

        totalTokens.input += result.usage.input;
        totalTokens.output += result.usage.output;
        totalTokens.inputChars += result.usage.inputChars;
        totalTokens.outputChars += result.usage.outputChars;

        const consolidated = normalizeFragmentOutput(result.output);
        if (hasAnalystSignal(consolidated)) {
            const finalData = mergeAnalystData(mergeAnalystData(emptyAnalystOutput(), aggregated), consolidated);
            debug.push({ chunk: 'final', fragment: 'consolidate', output: result.output, transcript: result.transcript });
            return {
                data: finalData,
                tokens: totalTokens,
                debug: JSON.stringify(debug, null, 2),
                provider,
                model
            };
        }
    }

    return {
        data: aggregated,
        tokens: totalTokens,
        debug: JSON.stringify(debug, null, 2),
        provider,
        model
    };
}

export async function runWriterAgent(input: WriterAgentInput): Promise<{ data: any | null; tokens: AgentTokens; debug: string; provider: AIProvider; model: string }> {
    // The narration comes out in the campaign's language (directive on both paths).
    const langDirective = aiOutputDirective(getCampaignLocale(input.campaignId));
    const sessionRag = new SessionRagIndex(input.narrativeText);
    const tools = createAgentTools(input.campaignId, sessionRag, input.manifesto || '');
    const analystJson = JSON.stringify(input.analystData, null, 2);
    const { client, model, provider, creds } = await getSummaryClient();

    if (isCloudLegacyProvider(provider) && process.env.AGENTIC_GEMINI_LEGACY_PROMPTS !== 'false') {
        console.log(`[Scrittore/Agent] ${provider}: uso prompt legacy monolitico + tool nativi.`);
        const result = await runAgent({
            name: `Scrittore:legacy-${provider}`,
            client,
            model,
            provider,
            creds,
            maxTurns: parseInt(process.env.AGENTIC_GEMINI_LEGACY_MAX_TURNS || '4', 10),
            jsonMode: true,
            outputSchema: WRITER_OUTPUT_SCHEMA,
            tools,
            requireToolUse: true,
            requiredTools: [],
            maxToolCalls: parseInt(process.env.AGENTIC_GEMINI_MAX_TOOL_CALLS || '3', 10),
            systemPrompt: input.manifesto
                ? `You are an expert D&D writer. Use the WORLD MANIFESTO as global context, the native tools to verify consistency, and return only valid JSON.\n\nWORLD MANIFESTO:\n${input.manifesto}`
                : 'You are an expert D&D writer. Use native tools to verify consistency and return only valid JSON.',
            userPrompt: agenticLegacyWriterPrompt(input, analystJson) + langDirective
        });

        return {
            data: result.output,
            tokens: result.usage,
            debug: JSON.stringify(result.transcript, null, 2),
            provider,
            model
        };
    }

    const isMultiPart = input.totalActs > 1;
    const writerNote = isMultiPart
        ? `This is PART ${input.actNumber} of ${input.totalActs}. ${input.actNumber > 1 ? 'Continue consistently with the previous parts.' : 'Set the initial tone and context.'}`
        : 'Single-part session.';
    const toneInstruction = input.tone === 'DM'
        ? 'DM tone: clear, useful at the table, with narrative and technical highlights.'
        : `Tone ${input.tone}: respect the requested style without altering the structured data.`;
    const prompt = `## AGENTIC WRITER TASK
${writerNote}
${toneInstruction}

## COMPACT CAST
${compactText(input.castContext, 5000)}

## COMPACT DYNAMIC MEMORY
${compactText(input.memoryContext, 10000)}

## VALIDATED ANALYST DATA
${compactText(analystJson, 18000)}

## TRANSCRIPT OVERVIEW
${JSON.stringify(sessionRag.overview(), null, 2)}

Use the native tools to retrieve relevant transcript windows, manifesto sections and historical details. Do not rewrite or correct the structured data: use it as a constraint.

Answer directly with valid JSON:
{
  "title": "short title",
  "summary": "narrative summary",
  "narrative": "complete tale of this part",
  "narrativeBrief": "maximum 1800 characters"
}`;

    if (provider === 'ollama' && process.env.AGENTIC_UNLOAD_BEFORE_PHASE !== 'false') {
        console.log(`[Scrittore/Agent] 🧹 Unload modello prima della fase: ${model}`);
        await unloadAgentModel(model);
    }
    const result = await runAgent({
        name: 'Scrittore',
        client,
        model,
        provider,
        creds,
        maxTurns: 4,
        jsonMode: true,
        outputSchema: WRITER_OUTPUT_SCHEMA,
        numCtx: 32768,
        tools,
        requireToolUse: true,
        requiredTools: [],
        maxToolCalls: parseInt(process.env.AGENTIC_MAX_TOOL_CALLS || '8', 10),
        unloadAfter: process.env.AGENTIC_UNLOAD_AFTER_WRITER === 'true',
        systemPrompt: `You are an expert D&D writer. You use read-only native tools to verify continuity, identities and historical details. Do not modify the structured data: write consistent narrative and return only valid final JSON.`,
        userPrompt: `${prompt}\n\nYou must call at least one native tool before the final JSON. Prefer get_transcript_window, search_session_rag, search_manifesto or get_entity_history with concrete names/terms from analyst data.${langDirective}`
    });

    return {
        data: result.output,
        tokens: result.usage,
        debug: JSON.stringify(result.transcript, null, 2),
        provider,
        model
    };
}
