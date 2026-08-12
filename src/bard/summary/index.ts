/**
 * Bard summary pipeline facade and orchestrator.
 */

import {
    factionRepository,
    getSessionAIOutput,
    getSessionCampaignId,
    getSessionNotes,
    getSessionStartTime,
    getSessionTranscript
} from '../../db';
import { config } from '../../config';
import { monitor } from '../../monitor';
import { getSummaryClient } from '../config';
import { smartSplitTranscript } from '../helpers';
import { getOrCreateManifesto } from '../manifesto';
import { normalizeMonsterList } from '../monsterContract';
import { parseSummaryData } from '../summaryData';
import { SummaryResponse, ToneKey } from '../types';
import { runActsPipeline } from './acts';
import { runQuestLifecycleAgent } from '../agent/questLifecycle';
import { buildCastContext, buildDynamicMemoryContext } from './hydration';
import { saveDebugFile } from './debug';
import { finalizeSummary } from './finalize';
import { processChronologicalSession } from './transcript';
import { SummaryPipelineContext } from './types';

function readCachedSummary(sessionId: string, tone: ToneKey): SummaryResponse | null {
    const cached = getSessionAIOutput(sessionId);
    const cachedSummary = cached ? parseSummaryData(cached.summaryData) : null;
    if (!cached || !cachedSummary) return null;

    if (cachedSummary.metadata.tone !== tone) {
        console.log(`[Bardo] ⚠️ Cache trovata ma con tono diverso (${cachedSummary.metadata.tone} vs ${tone}). Rigenero.`);
        return null;
    }

    console.log(`[Bardo] 💾 Trovata cache valida (generata il ${new Date(cached.lastGeneratedAt).toLocaleString()}). Uso dati salvati.`);
    console.log(`[Bardo] 🔍 DEBUG Cache artifacts: ${JSON.stringify(cached.analystData.artifacts?.slice(0, 2) || 'undefined')}`);
    return {
        summary: cachedSummary.narrative,
        title: cachedSummary.metadata.title,
        tokens: cachedSummary.metadata.tokens,
        narrativeBrief: cachedSummary.brief,
        log: cached.analystData.log,
        character_growth: cached.analystData.character_growth,
        npc_events: cached.analystData.npc_events,
        world_events: cached.analystData.world_events,
        loot: cached.analystData.loot,
        loot_removed: cached.analystData.loot_removed,
        quests: cached.analystData.quests,
        quest_lifecycle: cached.analystData.quest_lifecycle,
        monsters: normalizeMonsterList(cached.analystData.monsters),
        npc_dossier_updates: cached.analystData.npc_dossier_updates,
        location_updates: cached.analystData.location_updates,
        travel_sequence: cached.analystData.travel_sequence,
        present_npcs: cached.analystData.present_npcs,
        npc_locations: cached.analystData.npc_locations || [],
        faction_updates: cached.analystData.faction_updates || [],
        faction_affiliations: cached.analystData.faction_affiliations || [],
        party_alignment_change: cached.analystData.party_alignment_change,
        artifacts: cached.analystData.artifacts || [],
        artifact_events: cached.analystData.artifact_events || []
    };
}

export async function generateSummary(
    sessionId: string,
    tone: ToneKey = 'DM',
    narrativeText?: string,
    options: { skipAnalysis?: boolean; forceRegeneration?: boolean } = {}
): Promise<SummaryResponse> {
    const startAI = Date.now();
    try {
        const { model, provider } = await getSummaryClient();
        console.log(`[Bardo] 📚 Generazione Riassunto per sessione ${sessionId} (Model: ${model}, Force: ${options.forceRegeneration})...`);

        if (!options.forceRegeneration) {
            const cached = readCachedSummary(sessionId, tone);
            if (cached) return cached;
        }

        const transcriptions = getSessionTranscript(sessionId);
        const notes = getSessionNotes(sessionId);
        const startTime = getSessionStartTime(sessionId) || 0;
        const campaignId = getSessionCampaignId(sessionId) ?? null;

        if (transcriptions.length === 0 && notes.length === 0) {
            return { summary: "Nessuna trascrizione trovata.", title: "Sessione Vuota", tokens: 0 };
        }

        const partyFaction = campaignId ? factionRepository.getPartyFaction(campaignId) : null;
        const { castContext, playerCharacterNames } = buildCastContext(transcriptions, campaignId, partyFaction);

        let fullDialogue: string;
        if (narrativeText && narrativeText.length > 100) {
            fullDialogue = narrativeText;
            console.log(`[Bardo] ✅ Usando testo narrativo pulito (${fullDialogue.length} chars)`);
        } else {
            fullDialogue = processChronologicalSession(transcriptions, notes, startTime, campaignId || 0).linearText;
            console.log(`[Bardo] ⚠️ Fallback a trascrizioni standard (${fullDialogue.length} chars)`);
        }

        const dynamicMemoryContext = campaignId
            ? await buildDynamicMemoryContext(campaignId, fullDialogue, playerCharacterNames, partyFaction)
            : "";

        let worldManifesto = "";
        if (campaignId) {
            try {
                worldManifesto = await getOrCreateManifesto(campaignId);
            } catch (err) {
                console.error(`[Bardo] ⚠️ Failed to generate World Manifesto:`, err);
            }
        }

        const strictAgentic = Boolean((config.features as any).enableLocalStructuredPipeline || process.env.AGENTIC_STRICT === 'true');
        const isLowContextLocal = provider === 'ollama';
        const safeCharLimit = process.env.SUMMARY_PART_CHARS
            ? parseInt(process.env.SUMMARY_PART_CHARS, 10)
            : isLowContextLocal
                ? parseInt(process.env.LOCAL_SUMMARY_PART_CHARS || (strictAgentic ? '30000' : '300000'), 10)
                : parseInt(process.env.GEMINI_SUMMARY_PART_CHARS || '300000', 10);
        console.log(`[Bardo] 🧮 Split policy: provider=${provider}, model=${model}, partLimit=${safeCharLimit.toLocaleString()} chars, strict=${strictAgentic}`);

        const parts = smartSplitTranscript(fullDialogue, safeCharLimit);
        if (parts.length > 1) {
            console.warn(`[Bardo] ⚠️ ATTENZIONE: La sessione è ENORME (${fullDialogue.length} chars). Attivo modalità episodica in ${parts.length} parti.`);
        } else {
            console.log(`[Bardo] ✅ Sessione nei limiti (${fullDialogue.length} chars). Elaborazione singola standard.`);
        }

        const pipelineContext: SummaryPipelineContext = {
            sessionId,
            tone,
            options,
            startAI,
            campaignId,
            castContext,
            playerCharacterNames,
            fullDialogue,
            dynamicMemoryContext,
            worldManifesto,
            strictAgentic
        };

        const result = await runActsPipeline({
            sessionId: pipelineContext.sessionId,
            tone: pipelineContext.tone,
            parts,
            castContext: pipelineContext.castContext,
            dynamicMemoryContext: pipelineContext.dynamicMemoryContext,
            worldManifesto: pipelineContext.worldManifesto,
            options: pipelineContext.options,
            campaignId: pipelineContext.campaignId,
            strictAgentic: pipelineContext.strictAgentic,
            startAI: pipelineContext.startAI
        });

        if (campaignId && !options.skipAnalysis) {
            // The quest lifecycle is deliberately post-acts: a closure can happen
            // in the last part and has to be judged against the whole session, once.
            try {
                const lifecycleStartedAt = Date.now();
                const lifecycle = await runQuestLifecycleAgent({
                    campaignId,
                    sessionId,
                    narrativeText: fullDialogue,
                    analystData: result.aggregatedData,
                    manifesto: worldManifesto
                });
                result.accumulatedTokens += lifecycle.tokens.input + lifecycle.tokens.output;
                result.totalAnalystTokens.input += lifecycle.tokens.input;
                result.totalAnalystTokens.output += lifecycle.tokens.output;
                result.totalAnalystTokens.inputChars += lifecycle.tokens.inputChars;
                result.totalAnalystTokens.outputChars += lifecycle.tokens.outputChars;
                if (lifecycle.provider && lifecycle.model && lifecycle.tokens.input + lifecycle.tokens.output > 0) {
                    monitor.logAIRequestWithCost(
                        'quest-lifecycle',
                        lifecycle.provider,
                        lifecycle.model,
                        lifecycle.tokens.input,
                        lifecycle.tokens.output,
                        lifecycle.tokens.cached || 0,
                        Date.now() - lifecycleStartedAt,
                        false
                    );
                }
                result.aggregatedData.quest_lifecycle = lifecycle.data;
                result.aggregatedData.quests = lifecycle.data.decisions
                    .filter(decision =>
                        decision.confidence === 'HIGH' &&
                        (decision.action === 'STATUS_CHANGE' || decision.action === 'CREATE')
                    )
                    .map(decision => ({
                        id: decision.id,
                        title: decision.title,
                        description: decision.description,
                        status: decision.proposed_status,
                        type: decision.type
                    }));
                saveDebugFile(sessionId, 'quest_lifecycle_agent.json', lifecycle.debug);
            } catch (error: any) {
                // Fail closed: no output of the general Analyst may mutate a quest
                // if the lifecycle specialist has not completed its check.
                console.error(`[Quest Lifecycle] ⚠️ Valutazione fallita, quest invariate: ${error?.message || error}`);
                result.aggregatedData.quest_lifecycle = { decisions: [] };
                result.aggregatedData.quests = [];
            }
        }

        return finalizeSummary(sessionId, tone, parts.length, result);
    } catch (err: any) {
        console.error("[Bardo] ❌ Errore finale:", err);
        monitor.logAIRequestWithCost('summary', 'openai', 'gpt-4o-mini', 0, 0, 0, Date.now() - startAI, true);
        throw err;
    }
}

export { extractStructuredData } from './analyst';
export { prepareCleanText } from './transcript';
export { regenerateNpcNotes, generateNpcBiography, generateCharacterBiography } from './bios';
