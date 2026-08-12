/**
 * Episodic loop (acts): for each part of the session it runs
 * STEP A (Analyst, or hydration from the DB with skipAnalysis) and
 * STEP B (agentic Writer with a legacy fallback), aggregating data and tokens.
 * Body moved verbatim from the generateSummary monolith.
 */

import {
    getSessionLog,
    inventoryRepository,
    questRepository,
    bestiaryRepository,
    npcRepository,
    locationRepository
} from '../../db';
import { getSummaryClient } from '../config';
import { contextLimitsFor, isAgenticSummaryEnabled } from '../ai/resolver';
import { scopeForCampaign } from '../ai/scope';
import { withRetry, safeJsonParse } from '../helpers';
import { AnalystOutput, ToneKey } from '../types';
import { monitor } from '../../monitor';
import { config } from '../../config';
import { generateJson } from '../llm/generate';
import { WRITER_DM_PROMPT, WRITER_BARDO_PROMPT } from '../prompts';
import { aiOutputDirective, getCampaignLocale } from '../../i18n';
import { runWriterAgent } from '../agent/summaryAgents';
import { extractStructuredData, emptyAnalystOutput } from './analyst';
import { saveDebugFile } from './debug';

export interface ActsPipelineParams {
    sessionId: string;
    tone: ToneKey;
    parts: string[];
    castContext: string;
    dynamicMemoryContext: string;
    worldManifesto: string;
    options: { skipAnalysis?: boolean; forceRegeneration?: boolean };
    campaignId: number | null;
    strictAgentic: boolean;
    /** generateSummary start timestamp (for the monitor). */
    startAI: number;
}

export interface ActsPipelineResult {
    finalNarrative: string;
    accumulatedTokens: number;
    totalAnalystTokens: { input: number; output: number; inputChars: number; outputChars: number };
    totalWriterTokens: { input: number; output: number; inputChars: number; outputChars: number };
    aggregatedData: any;
}

export async function runActsPipeline(params: ActsPipelineParams): Promise<ActsPipelineResult> {
    const { sessionId, tone, parts, castContext, dynamicMemoryContext, worldManifesto, options, campaignId, strictAgentic, startAI } = params;

    let finalNarrative = "";
    let accumulatedTokens = 0;

    // Token Accumulators for Technical Report
    const totalAnalystTokens = { input: 0, output: 0, inputChars: 0, outputChars: 0 };
    const totalWriterTokens = { input: 0, output: 0, inputChars: 0, outputChars: 0 };

    // Data accumulator (Analyst + Writer)
    let aggregatedData: any = {
        title: "",
        narrativeBriefs: [] as string[], // One brief per act
        loot: [],
        loot_removed: [],
        quests: [],
        monsters: [],
        npc_dossier_updates: [],
        location_updates: [],
        travel_sequence: [],
        present_npcs: [],
        npc_locations: [],
        character_growth: [],
        npc_events: [],
        world_events: [],
        log: [],
        faction_updates: [],
        faction_affiliations: [],
        artifacts: [],
        artifact_events: []
    };

    // CICLO EPISODICO
    for (let i = 0; i < parts.length; i++) {
        const currentPart = parts[i];
        const isMultiPart = parts.length > 1;
        const actNumber = i + 1;

        console.log(`[Bardo] 🎬 Elaborazione Atto ${actNumber}/${parts.length}...`);

        // --- STEP A: ANALYST (for this part) ---
        let partialAnalystData: AnalystOutput = emptyAnalystOutput();

        if (!options.skipAnalysis) {
            // Note: we pass the global memoryContext and the part's context
            const partHeader = isMultiPart ? `PARTE ${actNumber} DI ${parts.length}` : undefined;
            const analystResult = await extractStructuredData(sessionId, currentPart, castContext, dynamicMemoryContext, partHeader, worldManifesto);
            partialAnalystData = analystResult.data;

            // Aggregate Analyst Tokens
            totalAnalystTokens.input += analystResult.tokens.input;
            totalAnalystTokens.output += analystResult.tokens.output;
            totalAnalystTokens.inputChars += analystResult.tokens.inputChars;
            totalAnalystTokens.outputChars += analystResult.tokens.outputChars;
        } else if (i === 0) {
            // HYDRATION (Only on first pass to avoid duplication if we were to loop, though hydration should be global)
            console.log(`[Bardo] ⏩ Skipping Analysis. Hydrating from DB for session ${sessionId}...`);

            // Hydrate Loot
            const dbLoot = inventoryRepository.getSessionInventory(sessionId);
            partialAnalystData.loot = dbLoot.map((l: any) => ({
                name: l.item_name,
                quantity: l.quantity,
                description: l.description
            }));

            // Hydrate Quests
            const dbQuests = questRepository.getSessionQuests(sessionId);
            partialAnalystData.quests = dbQuests.map((q: any) => ({
                title: q.title,
                description: q.description,
                status: q.status
            }));

            // Hydrate Monsters
            const dbMonsters = bestiaryRepository.getSessionMonsters(sessionId);
            partialAnalystData.monsters = dbMonsters.map((m: any) => ({
                name: m.name,
                status: m.status,
                description: m.description,
                abilities: safeJsonParse(m.abilities) || [],
                weaknesses: safeJsonParse(m.weaknesses) || [],
                resistances: safeJsonParse(m.resistances) || []
            }));

            // Hydrate NPCs
            const dbNpcs = npcRepository.getSessionEncounteredNPCs(sessionId);
            partialAnalystData.present_npcs = dbNpcs.map((n: any) => n.name);
            // Note: npc_dossier_updates is slightly different than encountered, it tracks CHANGES.
            // We might not be able to fully reconstruct "updates" vs "state", but for narrative context, present_npcs is key.

            // Hydrate Location/Travel
            const travelLog = locationRepository.getSessionTravelLog(sessionId);
            partialAnalystData.travel_sequence = travelLog.map((t: any) => ({
                macro: t.macro_location,
                micro: t.micro_location,
                reason: "Recorded in log"
            }));

            // If we have travel log, we can infer location updates roughly or leave empty as they are for atlas
            // partialAnalystData.location_updates = ...

            // Hydrate Logs
            partialAnalystData.log = getSessionLog(sessionId);
        }

        // Merge Analyst data
        if (partialAnalystData.loot) aggregatedData.loot.push(...partialAnalystData.loot);
        if (partialAnalystData.loot_removed) aggregatedData.loot_removed.push(...partialAnalystData.loot_removed);
        if (partialAnalystData.quests) aggregatedData.quests.push(...partialAnalystData.quests);
        if (partialAnalystData.monsters) aggregatedData.monsters.push(...partialAnalystData.monsters);
        if (partialAnalystData.npc_dossier_updates) aggregatedData.npc_dossier_updates.push(...partialAnalystData.npc_dossier_updates);
        if (partialAnalystData.location_updates) aggregatedData.location_updates.push(...partialAnalystData.location_updates);
        if (partialAnalystData.travel_sequence) aggregatedData.travel_sequence.push(...partialAnalystData.travel_sequence);
        if (partialAnalystData.present_npcs) aggregatedData.present_npcs.push(...partialAnalystData.present_npcs);
        if (partialAnalystData.npc_locations) aggregatedData.npc_locations.push(...partialAnalystData.npc_locations);
        if (partialAnalystData.log) aggregatedData.log.push(...partialAnalystData.log);
        if (partialAnalystData.character_growth) aggregatedData.character_growth.push(...partialAnalystData.character_growth);
        if (partialAnalystData.npc_events) aggregatedData.npc_events.push(...partialAnalystData.npc_events);
        if (partialAnalystData.world_events) aggregatedData.world_events.push(...partialAnalystData.world_events);
        // 🆕 Faction System
        if (partialAnalystData.faction_updates) aggregatedData.faction_updates.push(...partialAnalystData.faction_updates);
        if (partialAnalystData.faction_affiliations) aggregatedData.faction_affiliations.push(...partialAnalystData.faction_affiliations);
        // 🆕 Party Alignment
        if (partialAnalystData.party_alignment_change) {
            aggregatedData.party_alignment_change = partialAnalystData.party_alignment_change;
        }
        // 🆕 Artifacts
        if (partialAnalystData.artifacts) aggregatedData.artifacts.push(...partialAnalystData.artifacts);
        // 🆕 Artifact Events
        if (partialAnalystData.artifact_events) aggregatedData.artifact_events.push(...partialAnalystData.artifact_events);

        // --- STEP B: WRITER (for this part) ---
        console.log(`[Bardo] ✍️ STEP 2: Scrittore - Atto ${actNumber} (${tone})...`);
        const partialAnalystJson = JSON.stringify(partialAnalystData, null, 2);
        let parsed: any = null;

        let writerInject = "";
        if (isMultiPart) {
            writerInject = `\n\n[NOTE FOR THE AI: This is PART ${actNumber} of ${parts.length} of a long session. `;
            if (i > 0) writerInject += `Continue the narration consistently with the previous part.]`;
            else writerInject += `]`;
            writerInject += `\n\n`;
        }

        let reducePrompt = "";
        const narrativeContext = writerInject + `TRANSCRIPT PART ${actNumber}:\n${currentPart}`;

        if (tone === 'DM') {
            reducePrompt = WRITER_DM_PROMPT(castContext, dynamicMemoryContext, partialAnalystJson)
                + `\n\n${narrativeContext}`;
        } else {
            reducePrompt = WRITER_BARDO_PROMPT(tone, castContext, dynamicMemoryContext, partialAnalystJson)
                + `\n\n${narrativeContext}`;
        }
        // The narration's output language = the campaign's language (prompt in canonical
        // English, the final directive imposes the output language).
        if (campaignId) {
            reducePrompt += aiOutputDirective(getCampaignLocale(campaignId));
        }

        console.log(`[Bardo] 📏 Dimensione Prompt Scrittore: ${reducePrompt.length} chars`);

        // FILENAME FIX: Use standard name if single part, otherwise indexed
        const promptFileName = (!isMultiPart && i === 0) ? 'writer_prompt.txt' : `writer_prompt_act${actNumber}.txt`;
        saveDebugFile(sessionId, promptFileName, reducePrompt);

        if (campaignId && isAgenticSummaryEnabled(scopeForCampaign(campaignId))) {
            try {
                console.log(`[Bardo] 🧭 Scrittore agentico DB/RAG - Atto ${actNumber}...`);
                const writerAgent = await runWriterAgent({
                    campaignId,
                    sessionId,
                    tone,
                    actNumber,
                    totalActs: parts.length,
                    narrativeText: currentPart,
                    castContext,
                    memoryContext: dynamicMemoryContext,
                    analystData: partialAnalystData,
                    manifesto: worldManifesto
                });

                const responseFileName = (!isMultiPart && i === 0) ? 'writer_agent_response.json' : `writer_agent_response_act${actNumber}.json`;
                saveDebugFile(sessionId, responseFileName, writerAgent.debug);

                if (writerAgent.data && typeof writerAgent.data === 'object') {
                    parsed = writerAgent.data;
                    accumulatedTokens += writerAgent.tokens.input + writerAgent.tokens.output;
                    totalWriterTokens.input += writerAgent.tokens.input;
                    totalWriterTokens.output += writerAgent.tokens.output;
                    totalWriterTokens.inputChars += writerAgent.tokens.inputChars;
                    totalWriterTokens.outputChars += writerAgent.tokens.outputChars;
                    monitor.logAIRequestWithCost('summary', writerAgent.provider, writerAgent.model, writerAgent.tokens.input, writerAgent.tokens.output, writerAgent.tokens.cached || 0, Date.now() - startAI, false);
                }
            } catch (writerAgentError: any) {
                console.warn(`[Bardo] ⚠️ Scrittore agentico fallito, fallback legacy: ${writerAgentError?.message || writerAgentError}`);
                if (strictAgentic) {
                    throw writerAgentError;
                }
            }
        } else if (campaignId) {
            console.log('[Bardo] Scrittore agentico disattivato per questa campagna.');
        }

        if (!parsed) {
            if (strictAgentic && campaignId && isAgenticSummaryEnabled(scopeForCampaign(campaignId))) {
                throw new Error(`Scrittore agentico non ha prodotto JSON valido per Atto ${actNumber}; legacy fallback disabilitato.`);
            }
            const writerSystemContent = worldManifesto
                ? `You are an expert D&D assistant. Use the following WORLD MANIFESTO as the campaign's context:\n\n${worldManifesto}\n\nAnswer ONLY with valid JSON.`
                : "You are an expert D&D assistant. Answer ONLY with valid JSON.";

            const route = await getSummaryClient();
            const ai = await withRetry(() => generateJson({
                route,
                label: 'summary',
                system: writerSystemContent,
                prompt: reducePrompt,
                // Local Ollama: no output cap but an extended context; the other
                // providers keep the historical 16k output token limit.
                ...(route.provider === 'ollama'
                    ? { compatOptions: { options: { num_ctx: 8192 } } }
                    : { maxTokens: 16000 }),
            }));
            const { input: inputTokens, output: outputTokens, cached: cachedTokens } = ai.usage;
            accumulatedTokens += inputTokens + outputTokens;

            // 🆕 Context Window Logging + Prompt Caching Stats (for the single act)
            // The limit of the provider actually used by the route, not the instance's.
            const contextLimit = contextLimitsFor(route.provider).input;
            const contextPct = ((inputTokens / contextLimit) * 100).toFixed(1);
            const cachePct = inputTokens > 0 ? ((cachedTokens / inputTokens) * 100).toFixed(1) : '0';
            const cacheInfo = cachedTokens > 0 ? ` | 💾 Cached: ${cachedTokens.toLocaleString()} (${cachePct}%)` : '';
            console.log(`[Bardo] 📊 Token Usage (Atto ${actNumber}): ${inputTokens.toLocaleString()}/${contextLimit.toLocaleString()} (${contextPct}%)${cacheInfo}`);

            const content = ai.content || "{}";
            const responseFileName = (!isMultiPart && i === 0) ? 'writer_response.txt' : `writer_response_act${actNumber}.txt`;
            saveDebugFile(sessionId, responseFileName, content);

            // Aggregate Writer Tokens
            totalWriterTokens.input += inputTokens;
            totalWriterTokens.output += outputTokens;
            totalWriterTokens.inputChars += reducePrompt.length;
            totalWriterTokens.outputChars += content.length;

            parsed = ai.parsed;
            if (!parsed) {
                console.error(`[Bardo] ⚠️ Errore parsing JSON Atto ${actNumber}`);
                parsed = { summary: content, title: "Act " + actNumber + " Error" };
            }
        }

        let partialNarrative = parsed.narrative || parsed.summary || "";
        if (!partialNarrative && Array.isArray(parsed.log) && parsed.log.length > 0) {
            partialNarrative = parsed.log.join('\n');
        }

        // Unione narrativa
        if (finalNarrative.length > 0) {
            finalNarrative += `\n\n`;
        }
        finalNarrative += partialNarrative;

        // Merge the writer's data
        // NOTE: character_growth, npc_events, world_events, log are now handled by Analyst
        // if (parsed.character_growth) aggregatedData.character_growth.push(...parsed.character_growth);
        // if (parsed.npc_events) aggregatedData.npc_events.push(...parsed.npc_events);
        // if (parsed.world_events) aggregatedData.world_events.push(...parsed.world_events);
        // if (parsed.log) aggregatedData.log.push(...parsed.log);

        // Title (take the first valid one)
        if (!aggregatedData.title && parsed.title) aggregatedData.title = parsed.title;

        // NarrativeBrief (accumulated for every act)
        if (parsed.narrativeBrief && parsed.narrativeBrief.length > 10) {
            aggregatedData.narrativeBriefs.push(parsed.narrativeBrief);
        } else if (partialNarrative && partialNarrative.length > 10) {
            // Fallback: use the first 1800 chars of the partial narrative
            const fallbackBrief = partialNarrative.substring(0, 1800) + (partialNarrative.length > 1800 ? "..." : "");
            aggregatedData.narrativeBriefs.push(fallbackBrief);
        }

    } // FINE LOOP EPISODICO

    return { finalNarrative, accumulatedTokens, totalAnalystTokens, totalWriterTokens, aggregatedData };
}
