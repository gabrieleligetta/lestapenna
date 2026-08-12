import { saveSessionAIOutput } from '../../db';
import { SummaryResponse, ToneKey } from '../types';
import { buildSummaryData } from '../summaryData';
import { dedupeNpcLocationsLastWins } from './analyst';
import { ActsPipelineResult } from './acts';
import { saveDebugFile } from './debug';

export function finalizeSummary(
    sessionId: string,
    tone: ToneKey,
    partCount: number,
    result: ActsPipelineResult
): SummaryResponse {
    const {
        finalNarrative,
        accumulatedTokens,
        totalAnalystTokens,
        totalWriterTokens,
        aggregatedData
    } = result;

    saveDebugFile(sessionId, 'analyst_tokens.json', JSON.stringify({
        phase: 'analyst',
        input: totalAnalystTokens.input,
        output: totalAnalystTokens.output,
        total: totalAnalystTokens.input + totalAnalystTokens.output,
        inputChars: totalAnalystTokens.inputChars,
        outputChars: totalAnalystTokens.outputChars
    }, null, 2));

    saveDebugFile(sessionId, 'writer_tokens.json', JSON.stringify({
        phase: 'writer',
        input: totalWriterTokens.input,
        output: totalWriterTokens.output,
        total: totalWriterTokens.input + totalWriterTokens.output,
        inputChars: totalWriterTokens.inputChars,
        outputChars: totalWriterTokens.outputChars
    }, null, 2));

    console.log(`[Bardo] 🏁 generateSummary completato (Totale ${partCount} parti).`);

    aggregatedData.npc_locations = dedupeNpcLocationsLastWins(aggregatedData.npc_locations);

    const summaryData = buildSummaryData({
        title: aggregatedData.title || `Sessione del ${new Date().toLocaleDateString()}`,
        tone,
        tokens: accumulatedTokens,
        narrative: finalNarrative || "Errore generazione.",
        briefs: aggregatedData.narrativeBriefs
    });

    saveSessionAIOutput(sessionId, aggregatedData, summaryData);
    console.log(`[Bardo] 💾 Salvati dati Analyst e Summary nel DB.`);

    return {
        summary: summaryData.narrative,
        title: summaryData.metadata.title,
        tokens: accumulatedTokens,
        narrativeBrief: summaryData.brief,
        log: aggregatedData.log,
        character_growth: aggregatedData.character_growth,
        npc_events: aggregatedData.npc_events,
        world_events: aggregatedData.world_events,
        loot: aggregatedData.loot,
        loot_removed: aggregatedData.loot_removed,
        quests: aggregatedData.quests,
        quest_lifecycle: aggregatedData.quest_lifecycle,
        monsters: aggregatedData.monsters,
        npc_dossier_updates: aggregatedData.npc_dossier_updates,
        location_updates: aggregatedData.location_updates,
        travel_sequence: aggregatedData.travel_sequence,
        present_npcs: aggregatedData.present_npcs,
        npc_locations: aggregatedData.npc_locations,
        faction_updates: aggregatedData.faction_updates,
        faction_affiliations: aggregatedData.faction_affiliations,
        party_alignment_change: aggregatedData.party_alignment_change,
        artifacts: aggregatedData.artifacts,
        artifact_events: aggregatedData.artifact_events
    };
}
