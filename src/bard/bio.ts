/**
 * Bard Bio - Unified Biography Generation Service
 * Handles Characters (PC), NPCs, and Locations (Atlas)
 */

import { getMetadataClient } from './config';
import { monitor } from '../monitor';
import { generateJson, generateText } from './llm/generate';
import {
    UPDATE_CHARACTER_BIO_PROMPT,
    REGENERATE_NPC_NOTES_PROMPT,
    CHARACTER_NARRATIVE_BIO_PROMPT
} from './prompts';
import { aiOutputDirective, getCampaignLocale } from '../i18n';
import {
    buildEuroCostSnapshot,
    calculateActualAiCost,
    getUsdEurRate,
} from '../services/aiCostTransparency';

/** Language directive for the bios: the campaign's when known, otherwise the chronicle's. */
function bioLanguageDirective(campaignId?: number): string {
    if (campaignId) return aiOutputDirective(getCampaignLocale(campaignId));
    return '\n\nIMPORTANT: Write the output in the SAME language as the event chronology provided.';
}

export type BioEntityType = 'CHARACTER' | 'NPC' | 'LOCATION' | 'QUEST' | 'MONSTER' | 'ITEM' | 'FACTION' | 'ARTIFACT';

export interface BioGenerationCost {
    costUsd: number | null;
    costEur: number | null;
}

interface BioContext {
    campaignId?: number; // Optional for backward compat or forced? Should be required really.
    name: string;
    // Context fields (optional based on type)
    role?: string;       // NPC
    class?: string;      // PC
    race?: string;       // PC
    macro?: string;      // Location
    micro?: string;      // Location
    currentDesc?: string;
    foundationDescription?: string; // PC Foundation Bio
    manualDescription?: string; // 🆕 Manual guidance for the AI
    /** Manual actions must surface provider failures instead of swallowing them. */
    throwOnError?: boolean;
    /** Optional operation-level collector used by explicitly paid regenerations. */
    onActualCost?: (cost: BioGenerationCost) => void;
}

/**
 * Generates a prompt specific to the entity type
 */
function generatePrompt(type: BioEntityType, ctx: BioContext, historyText: string): string {
    const complexity = historyText.length > 500 ? "DETAILED" : "CONCISE";

    let promptText = '';

    switch (type) {
        case 'CHARACTER':
            promptText = CHARACTER_NARRATIVE_BIO_PROMPT(ctx.name, ctx.foundationDescription || '', historyText);
            break;
        case 'NPC':
            promptText = REGENERATE_NPC_NOTES_PROMPT(ctx.name, ctx.role || 'Unknown', ctx.currentDesc || '', historyText, complexity);
            break;
        case 'LOCATION':
            promptText = `You are the Archivist of a Fantasy Atlas.
    You must update the description of the place: **${ctx.macro || '?'} - ${ctx.micro || '?'}**.

    EXISTING DESCRIPTION:
    "${ctx.currentDesc || ''}"

    RECENT EVENTS/OBSERVATIONS (Chronology):
    ${historyText}

    GOAL:
    Write an updated description that blends the original atmosphere with the significant new events.

    INSTRUCTIONS:
    1. **Atmosphere:** Keep the evocative style.
    2. **Integration:** If the chronology says "the inn burned down", the description MUST reflect the ruined state.
    3. **Format:** Single descriptive text, no bullet lists.
    4. **Limits:** Maximum 3500 characters.

    Return ONLY the text of the new description.`;
            break;
        case 'QUEST':
            promptText = `You are the Bard, keeper of deeds. Write the **Mission Journal** for the quest: "${ctx.name}".
CURRENT STATUS: ${ctx.role || 'In Progress'}

EVENT CHRONOLOGY:
${historyText}

GOAL:
Write a narrative summary of the mission that integrates the events that happened.
- Style: Logbook or adventurous chronicle.
- Include the goals achieved and those failed.
- If the quest is over, write an epilogue.
- NO bullet lists, use fluid paragraphs.
- Length: Maximum 3000 characters.`;
            break;
        case 'MONSTER':
            promptText = `You are a Monster Scholar. Write the **Ecological Dossier** for: "${ctx.name}".
EXISTING NOTES: ${ctx.currentDesc || 'None'}

OBSERVATIONS AND ENCOUNTERS:
${historyText}

GOAL:
Compile a technical yet narrative description of the creature based ONLY on what was observed.
- Describe appearance, behavior and abilities seen.
- Highlight discovered weaknesses or resistances (e.g. "It seems to fear fire").
- Do not invent facts unsupported by the history.
- Style: Academic but practical (Survival Manual).
- Length: Maximum 3500 characters.`;
            break;
        case 'ITEM':
            promptText = `You are an Arcane Antiquarian. Write the **Legend** of the item: "${ctx.name}".
BASE DESCRIPTION: ${ctx.currentDesc || 'None'}

ITEM HISTORY:
${historyText}

GOAL:
Write the item's story based on how it changed hands and was used.
- Who found it? Who used it?
- Did it show particular powers?
- Was it damaged or altered over time?
- Style: Magic auction catalog entry or whispered legend.
- Length: Maximum 3000 characters.`;
            break;
        case 'FACTION':
            promptText = `You are a Political Historian. Write the **Intelligence Report** for the faction: "${ctx.name}".
EXISTING DESCRIPTION: ${ctx.currentDesc || 'None'}

RECENT MOVES AND ACTIONS:
${historyText}

GOAL:
Update the faction's description integrating its recent moves and status/reputation changes.
- How have its alliances changed?
- Did it gain or lose influence?
- Style: Analytical and persuasive.
- Focus: Political goals, reputation and power structure.
- Length: Maximum 3500 characters.`;
            break;
        case 'ARTIFACT':
            promptText = `You are the Keeper of Relics. Write the **History of the Artifact**: "${ctx.name}".
EXISTING DESCRIPTION: ${ctx.currentDesc || 'None'}

EVENTS AND USES:
${historyText}

GOAL:
Narrate the artifact's recent history, who wielded it and which powers it manifested.
- If it changed owner, describe how.
- If new powers or curses emerged, integrate them into the description.
- Style: Mythological and solemn.
- Length: Maximum 3000 characters.`;
            break;
        default:
            promptText = `Update the description of ${ctx.name} based on: ${historyText}`;
    }

    // 🆕 UNIVERSAL MANUAL DESCRIPTION PROTECTION
    if (ctx.manualDescription) {
        promptText = `⚠️ BINDING MANUAL DESCRIPTION (FOUNDATION):
"${ctx.manualDescription}"

${promptText}

CRITICAL INSTRUCTION:
Do not contradict the manual description. Use it as the skeleton and enrich it with the recent events, but keep the key facts established by the user unchanged.`;
    }

    return promptText;
}


/**
 * Unified Bio Generator
 */
export async function generateBio(
    type: BioEntityType,
    ctx: BioContext,
    historyEvents: Array<{ description: string, event_type: string }>
): Promise<string> {

    // 1. Filter empty events
    const validEvents = historyEvents.filter(e => e.description && e.description.trim().length > 0);

    if (validEvents.length === 0) {
        console.log(`[BioGen] ⏩ Nessun evento per ${type} ${ctx.name}, skip regen.`);
        return ctx.currentDesc || "";
    }

    // 2. Prepare History Text
    // Limit history length to fit context window if needed, prioritizing recent events?
    // For now, take last 20 events.
    const recentEvents = validEvents.slice(-20);
    const historyText = recentEvents
        .map(h => `[${h.event_type}] ${h.description}`)
        .join('\n');

    console.log(`[BioGen] 🧬 Generazione bio per ${type} ${ctx.name} (${validEvents.length} eventi)...`);

    // 3. Select Prompt
    const prompt = generatePrompt(type, ctx, historyText) + bioLanguageDirective(ctx.campaignId);

    // 4. Call LLM
    const startAI = Date.now();
    try {
        const ai = await generateText({
            route: await getMetadataClient(),
            label: 'bio_gen',
            system: "You are an expert fantasy biographer and archivist. Be concise when needed to stay within space limits.",
            prompt,
            lightModel: true,
            maxTokens: 1000 // Ensure output is well within Discord's 4096 char limit for descriptions
        });
        const actualCost = calculateActualAiCost(ai.provider, ai.model, ai.usage);
        let costEur: number | null = null;
        if (actualCost.costUsd !== null) {
            costEur = actualCost.costUsd === 0
                ? 0
                : buildEuroCostSnapshot(actualCost.costUsd, await getUsdEurRate()).costEur;
        }
        ctx.onActualCost?.({ costUsd: actualCost.costUsd, costEur });
        const newDesc = ai.content.trim() || ctx.currentDesc || "";

        // 5. Persist Changes (Phase 2 Unification)
        if (ctx.campaignId) {
            const campaignId = ctx.campaignId;
            switch (type) {
                case 'QUEST': {
                    const { questRepository } = await import('../db/repositories/QuestRepository');
                    questRepository.updateQuestDescription(campaignId, ctx.name, newDesc);
                    break;
                }
                case 'MONSTER': {
                    const { bestiaryRepository } = await import('../db/repositories/BestiaryRepository');
                    bestiaryRepository.updateBestiaryDescription(campaignId, ctx.name, newDesc);
                    break;
                }
                case 'ITEM': {
                    const { inventoryRepository } = await import('../db/repositories/InventoryRepository');
                    inventoryRepository.updateInventoryDescription(campaignId, ctx.name, newDesc);
                    break;
                }
                case 'FACTION': {
                    const { factionRepository } = await import('../db/repositories/FactionRepository');
                    factionRepository.updateFaction(campaignId, ctx.name, { description: newDesc }, false);
                    break;
                }
                case 'ARTIFACT': {
                    const { artifactRepository } = await import('../db/repositories/ArtifactRepository');
                    artifactRepository.updateArtifactDescription(campaignId, ctx.name, newDesc);
                    break;
                }
            }
        }

        console.log(`[BioGen] ✅ Bio aggiornata per ${ctx.name} (${newDesc.length} chars)`);
        return newDesc;

    } catch (e) {
        console.error(`[BioGen] ❌ Errore generazione bio per ${ctx.name}:`, e);
        // Fallback static logging on failure since we might not have dynamic provider initialized
        monitor.logAIRequestWithCost('bio_gen', 'openai', 'gpt-4o-mini', 0, 0, 0, Date.now() - startAI, true);
        if (ctx.throwOnError) throw e;
        return ctx.currentDesc || "";
    }
}

/**
 * Generates descriptions for several entities in a single call (~40% token saving)
 */
/**
 * Generates descriptions for several entities in a single call (~40% token saving)
 */
export async function generateBioBatch(
    type: BioEntityType,
    items: Array<{ name: string, context: BioContext, history: string }>
): Promise<Record<string, string>> {

    if (items.length === 0) return {};

    console.log(`[BioBatch] 🧬 Avvio generazione batch per ${items.length} entità di tipo ${type}...`);

    const batchLanguageDirective = bioLanguageDirective(items[0]?.context.campaignId);

    // Costruiamo un payload compatto
    const payload = items.map(i => ({
        id: i.name,
        current_desc: i.context.currentDesc?.substring(0, 500) || "None", // Tronchiamo per risparmiare input
        manual_guidance: i.context.manualDescription || null, // 🆕 Include guida manuale
        recent_events: i.history
    }));

    const systemPrompt = `You are the ${type} Archivist. Update the descriptions of the following entities based on the new events.
Be CONCISE (max 3 sentences per entity).
IMPORTANT: If "manual_guidance" is present, use it as a binding skeleton. Do not contradict it.
Return ONLY valid JSON in the format: { "Entity Name": "New Description" }.` + batchLanguageDirective;

    try {
        const ai = await generateJson({
            route: await getMetadataClient(),
            label: 'bio_batch',
            system: systemPrompt,
            prompt: JSON.stringify(payload),
            lightModel: true,
            maxTokensNative: 6000,
            // Riscrittura descrizioni in batch = task di estrazione/riformulazione semplice,
            // caso da manuale per un effort/thinking basso (vedi GenerateParams.reasoningEffort).
            reasoningEffort: 'low'
        });
        return ai.parsed || {}; // Mappa { "Nome": "Descrizione" }

    } catch (e) {
        console.error(`[BioBatch] Errore batch:`, e);
        return {}; // Fallback sicuro
    }
}
