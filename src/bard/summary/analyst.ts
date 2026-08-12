/**
 * Analyst phase: normalization of the structured output + data extraction
 * (agentic loop with a legacy fallback).
 */

import { getSessionCampaignId, locationRepository, normalizeQuestStatus, normalizeQuestType, QuestStatus } from '../../db';
import { getAnalystClient } from '../config';
import { contextLimitsFor, isAgenticSummaryEnabled } from '../ai/resolver';
import { scopeForCampaign } from '../ai/scope';
import { normalizeStringList, normalizeLootList } from '../helpers';
import { AnalystOutput } from '../types';
import { monitor } from '../../monitor';
import { config } from '../../config';
import { generateJson } from '../llm/generate';
import { ANALYST_PROMPT } from '../prompts';
import { aiOutputDirective, getCampaignLocale } from '../../i18n';
import { runAnalystAgent } from '../agent/summaryAgents';
import { normalizeMonsterList } from '../monsterContract';
import { saveDebugFile } from './debug';

/**
 * Utility: Normalize location names
 */
export function normalizeLocationNames(macro: string, micro: string): { macro: string; micro: string } {
    if (micro.startsWith(macro + " - ")) {
        micro = micro.substring(macro.length + 3);
    }
    return { macro, micro };
}

export function buildAnalystAtlasContext(campaignId: number | null | undefined): string {
    if (!campaignId) return "";

    const locations = locationRepository.listAllAtlasEntries(campaignId);
    if (!locations.length) {
        return `\n## CANONICAL ATLAS (0 places)\nNo places in the atlas. For new places, use the same macro/micro in travel_sequence, location_updates and npc_locations.\n`;
    }

    const rows = locations.map((loc: any) => {
        const id = loc.short_id ? `[ID: ${loc.short_id}] ` : "";
        return `- ${id}${loc.macro_location} - ${loc.micro_location}`;
    });

    return `\n## CANONICAL ATLAS (${locations.length} places)\nUse this list to pick location_id/macro/micro in npc_locations when the NPC is in an already-known place. Do not invent IDs.\n${rows.join('\n')}\n`;
}

export function normalizeNpcLocations(value: any): Array<{ name: string; location_id?: string; macro?: string; micro?: string }> {
    if (!Array.isArray(value)) return [];

    return value.map((entry: any) => {
        if (!entry || typeof entry !== 'object') return null;

        const name = typeof entry.name === 'string' ? entry.name.trim() : "";
        const locationId = typeof entry.location_id === 'string'
            ? entry.location_id.replace(/^#/, '').trim()
            : (typeof entry.id === 'string' ? entry.id.replace(/^#/, '').trim() : "");
        const macro = typeof entry.macro === 'string' ? entry.macro.trim() : "";
        const micro = typeof entry.micro === 'string' ? entry.micro.trim() : "";

        if (!name || (!locationId && (!macro || !micro))) return null;

        const normalized = macro && micro ? normalizeLocationNames(macro, micro) : { macro, micro };
        return {
            name,
            ...(locationId ? { location_id: locationId } : {}),
            ...(normalized.macro ? { macro: normalized.macro } : {}),
            ...(normalized.micro ? { micro: normalized.micro } : {})
        };
    }).filter(Boolean) as Array<{ name: string; location_id?: string; macro?: string; micro?: string }>;
}

export function dedupeNpcLocationsLastWins(locations: Array<{ name: string; location_id?: string; macro?: string; micro?: string }>): Array<{ name: string; location_id?: string; macro?: string; micro?: string }> {
    const byNpc = new Map<string, { name: string; location_id?: string; macro?: string; micro?: string }>();

    for (const loc of locations || []) {
        if (!loc?.name) continue;
        byNpc.set(loc.name.toLowerCase(), loc);
    }

    return Array.from(byNpc.values());
}

export function emptyAnalystOutput(): AnalystOutput {
    return {
        loot: [], loot_removed: [], quests: [], monsters: [],
        npc_dossier_updates: [], location_updates: [], travel_sequence: [], present_npcs: [], npc_locations: [],
        log: [], character_growth: [], npc_events: [], world_events: [],
        faction_updates: [], faction_affiliations: [], artifacts: [], artifact_events: []
    };
}

export function normalizeAnalystOutput(parsed: any): AnalystOutput {
    const validStatuses = ['ALIVE', 'DEAD', 'MISSING'] as const;
    const normalizedNpcUpdates = Array.isArray(parsed?.npc_dossier_updates)
        ? parsed.npc_dossier_updates.map((npc: any) => ({
            id: npc.id,
            name: npc.name,
            description: npc.description,
            role: npc.role,
            status: validStatuses.includes(npc.status) ? npc.status as 'ALIVE' | 'DEAD' | 'MISSING' : undefined,
            alignment_moral: npc.alignment_moral,
            alignment_ethical: npc.alignment_ethical
        }))
            .filter((npc: any) => npc.description && npc.description.length > 5 && !['nessuna nota', 'no notes'].some(p => npc.description.toLowerCase().includes(p)))
        : [];

    const normalizedLocationUpdates = (Array.isArray(parsed?.location_updates) ? parsed.location_updates : []).map((loc: any) => {
        if (loc.macro && loc.micro) {
            const normalized = normalizeLocationNames(loc.macro, loc.micro);
            return { ...loc, macro: normalized.macro, micro: normalized.micro };
        }
        return loc;
    }).filter((loc: any) => loc.description && loc.description.trim().length > 10 && !['nessuna descrizione', 'no description'].some(p => loc.description.toLowerCase().includes(p)));

    const normalizedTravelSequence = (Array.isArray(parsed?.travel_sequence) ? parsed.travel_sequence : []).map((step: any) => {
        if (step.macro && step.micro) {
            const normalized = normalizeLocationNames(step.macro, step.micro);
            return { ...step, macro: normalized.macro, micro: normalized.micro };
        }
        return step;
    });

    const normalizedQuests = (Array.isArray(parsed?.quests) ? parsed.quests : []).map((q: any) => {
        if (typeof q === 'string') {
            return { title: q, description: '', status: 'OPEN' };
        }
        return {
            id: q.id,
            title: q.title,
            description: q.description || '',
            status: normalizeQuestStatus(q.status) || QuestStatus.OPEN,
            type: normalizeQuestType(q.type) || undefined
        };
    }).filter((q: any) => q.title);

    return {
        loot: normalizeLootList(parsed?.loot),
        loot_removed: normalizeLootList(parsed?.loot_removed),
        quests: normalizedQuests,
        monsters: normalizeMonsterList(parsed?.monsters),
        npc_dossier_updates: normalizedNpcUpdates,
        location_updates: normalizedLocationUpdates,
        travel_sequence: normalizedTravelSequence,
        present_npcs: normalizeStringList(parsed?.present_npcs),
        npc_locations: normalizeNpcLocations(parsed?.npc_locations),
        log: normalizeStringList(parsed?.log),
        character_growth: Array.isArray(parsed?.character_growth) ? parsed.character_growth : [],
        npc_events: Array.isArray(parsed?.npc_events) ? parsed.npc_events : [],
        world_events: Array.isArray(parsed?.world_events) ? parsed.world_events : [],
        faction_updates: Array.isArray(parsed?.faction_updates) ? parsed.faction_updates : [],
        faction_affiliations: Array.isArray(parsed?.faction_affiliations) ? parsed.faction_affiliations : [],
        party_alignment_change: parsed?.party_alignment_change || undefined,
        artifacts: Array.isArray(parsed?.artifacts) ? parsed.artifacts : [],
        artifact_events: Array.isArray(parsed?.artifact_events) ? parsed.artifact_events : []
    };
}

export async function extractStructuredData(sessionId: string, narrativeText: string, castContext: string, memoryContext: string, partContext?: string, manifesto: string = ""): Promise<{ data: AnalystOutput, tokens: { input: number, output: number, inputChars: number, outputChars: number } }> {
    console.log(`[Analista] 📊 Estrazione dati strutturati (${narrativeText.length} chars)${partContext ? ` [${partContext}]` : ''}...`);

    // Inject the part's context when present
    const effectiveText = partContext ? `[[${partContext}]]\n\n${narrativeText}` : narrativeText;
    const campaignId = getSessionCampaignId(sessionId);
    const strictAgentic = Boolean((config.features as any).enableLocalStructuredPipeline || process.env.AGENTIC_STRICT === 'true');
    const atlasContext = buildAnalystAtlasContext(campaignId);
    // The extracted texts (events, descriptions) end up in the DB: campaign language.
    const langDirective = campaignId ? aiOutputDirective(getCampaignLocale(campaignId)) : '';
    const prompt = ANALYST_PROMPT(castContext, memoryContext, effectiveText, atlasContext) + langDirective;
    saveDebugFile(sessionId, 'analyst_prompt.txt', prompt);

    const startAI = Date.now();
    if (campaignId && isAgenticSummaryEnabled(scopeForCampaign(campaignId))) {
        try {
            console.log(`[Analista] 🧭 Avvio loop agentico DB/RAG...`);
            const agentResult = await runAnalystAgent({
                campaignId,
                sessionId,
                narrativeText,
                castContext,
                memoryContext,
                atlasContext,
                partContext,
                manifesto
            });

            saveDebugFile(sessionId, partContext ? `analyst_agent_${partContext.replace(/\s+/g, '_').toLowerCase()}.json` : 'analyst_agent.json', agentResult.debug);

            if (agentResult.data && typeof agentResult.data === 'object') {
                const normalized = normalizeAnalystOutput(agentResult.data);
                const hasSignal = normalized.log.length > 0 ||
                    normalized.present_npcs.length > 0 ||
                    normalized.quests.length > 0 ||
                    normalized.npc_events.length > 0 ||
                    normalized.world_events.length > 0 ||
                    normalized.location_updates.length > 0;

                if (hasSignal) {
                    saveDebugFile(sessionId, 'analyst_response.txt', JSON.stringify(agentResult.data, null, 2));
                    monitor.logAIRequestWithCost('analyst', agentResult.provider, agentResult.model, agentResult.tokens.input, agentResult.tokens.output, agentResult.tokens.cached || 0, Date.now() - startAI, false);
                    return {
                        data: normalized,
                        tokens: agentResult.tokens
                    };
                }

                console.warn('[Analista] ⚠️ Loop agentico senza segnali utili, fallback legacy.');
                if (strictAgentic) {
                    throw new Error('Loop agentico senza segnali utili in modalita strict.');
                }
            }
        } catch (agentError: any) {
            console.warn(`[Analista] ⚠️ Loop agentico fallito, fallback legacy: ${agentError?.message || agentError}`);
            if (strictAgentic) {
                throw agentError;
            }
        }
    } else if (campaignId) {
        console.log('[Analista] Loop agentico disattivato per questa campagna.');
    }

    try {
        const route = await getAnalystClient();
        const ai = await generateJson({
            route,
            label: 'analyst',
            system: `You are a data analyst. Use the following WORLD MANIFESTO as the campaign's global context:\n\n${manifesto}\n\nAnswer ONLY with valid JSON.`,
            prompt
        });
        const { input: inputTokens, output: outputTokens, cached: cachedTokens } = ai.usage;

        // 🆕 Context Window Logging + Prompt Caching Stats
        // The limits are those of the provider REALLY used by the route: with the
        // per-table choice, reading them from the instance configuration would
        // mean measuring the percentage against a window this call never had.
        const { input: contextLimit, output: outputLimit } = contextLimitsFor(route.provider);
        const contextPct = ((inputTokens / contextLimit) * 100).toFixed(1);
        const outputPct = ((outputTokens / outputLimit) * 100).toFixed(1);
        const cachePct = inputTokens > 0 ? ((cachedTokens / inputTokens) * 100).toFixed(1) : '0';
        const contextWarning = inputTokens > contextLimit * 0.8 ? '⚠️ NEAR LIMIT!' : '';
        const outputWarning = outputTokens > outputLimit * 0.8 ? '⚠️ NEAR LIMIT!' : '';
        const cacheInfo = cachedTokens > 0 ? ` | 💾 Cached: ${cachedTokens.toLocaleString()} (${cachePct}%)` : '';
        console.log(`[Analista] 📊 Token Usage: ${inputTokens.toLocaleString()}/${contextLimit.toLocaleString()} input (${contextPct}%) ${contextWarning} | ${outputTokens.toLocaleString()}/${outputLimit.toLocaleString()} output (${outputPct}%) ${outputWarning}${cacheInfo}`);

        const content = ai.content || "{}";
        saveDebugFile(sessionId, 'analyst_response.txt', content);
        const parsed = ai.parsed;

        // 🔍 DEBUG: Check artifacts in parsed JSON
        console.log(`[Analista] 🔍 DEBUG parsed.artifacts: ${JSON.stringify(parsed?.artifacts?.slice(0, 2) || 'undefined/null')}`);

        return {
            data: normalizeAnalystOutput(parsed),
            tokens: { input: inputTokens, output: outputTokens, inputChars: prompt.length, outputChars: content.length }
        };

    } catch (e: any) {
        console.error('[Analista] ❌ Errore estrazione dati:', e.message);
        monitor.logAIRequestWithCost('analyst', 'openai', 'gpt-4o-mini', 0, 0, 0, Date.now() - startAI, true);
        return {
            data: emptyAnalystOutput(),
            tokens: { input: 0, output: 0, inputChars: 0, outputChars: 0 }
        };
    }
}
