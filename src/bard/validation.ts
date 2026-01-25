/**
 * Bard Validation - Batch validation system
 */

import { ValidationBatchInput, ValidationBatchOutput } from './types';
import { metadataClient, METADATA_PROVIDER, METADATA_MODEL } from './config';
import { monitor } from '../monitor';
import { getNpcHistory, getCharacterHistory, getOpenQuests } from '../db';
import { VALIDATION_PROMPT } from './prompts';

/**
 * Costruisce il prompt per la validazione batch
 */
function buildValidationPrompt(context: any, input: ValidationBatchInput): string {
    return VALIDATION_PROMPT(context, input);
}

/**
 * VALIDATORE BATCH UNIFICATO - Ottimizzato per costi
 */
export async function validateBatch(
    campaignId: number,
    input: ValidationBatchInput
): Promise<ValidationBatchOutput> {

    const context: any = {};

    if (input.npc_events && input.npc_events.length > 0) {
        const npcNames = [...new Set(input.npc_events.map(e => e.name))];
        context.npcHistories = {};

        for (const name of npcNames) {
            const history = getNpcHistory(campaignId, name).slice(-10);
            if (history.length > 0) {
                context.npcHistories[name] = history.map((h: any) =>
                    `[${h.event_type}] ${h.description}`
                ).join('; ');
            }
        }
    }

    if (input.character_events && input.character_events.length > 0) {
        const charNames = [...new Set(input.character_events.map(e => e.name))];
        context.charHistories = {};

        for (const name of charNames) {
            const history = getCharacterHistory(campaignId, name).slice(-3);
            if (history.length > 0) {
                context.charHistories[name] = history.map((h: any) =>
                    `[${h.event_type}] ${h.description}`
                ).join('; ');
            }
        }
    }

    if (input.quests && input.quests.length > 0) {
        context.existingQuests = getOpenQuests(campaignId).map((q: any) => q.title);
    }

    const prompt = buildValidationPrompt(context, input);

    const startAI = Date.now();
    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [
                { role: "system", content: "Sei il Custode degli Archivi di una campagna D&D. Valida dati in batch. Rispondi SOLO con JSON valido in italiano." },
                { role: "user", content: prompt }
            ],
            response_format: { type: "json_object" }
        });

        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;

        monitor.logAIRequestWithCost('metadata', METADATA_PROVIDER, METADATA_MODEL, inputTokens, outputTokens, cachedTokens, latency, false);

        console.log(`[Validator] Validazione completata in ${latency}ms (${inputTokens}+${outputTokens} tokens)`);

        const result = JSON.parse(response.choices[0].message.content || "{}");

        return {
            npc_events: result.npc_events || { keep: input.npc_events || [], skip: [] },
            character_events: result.character_events || { keep: input.character_events || [], skip: [] },
            world_events: result.world_events || { keep: input.world_events || [], skip: [] },
            loot: result.loot || { keep: input.loot || [], skip: [] },
            loot_removed: result.loot_removed || { keep: input.loot_removed || [], skip: [] },
            quests: result.quests || { keep: input.quests || [], skip: [] },
            atlas: result.atlas || { action: 'keep' }
        };

    } catch (e: any) {
        console.error('[Validator] Errore batch validation:', e);
        monitor.logAIRequestWithCost('metadata', METADATA_PROVIDER, METADATA_MODEL, 0, 0, 0, Date.now() - startAI, true);

        return {
            npc_events: { keep: input.npc_events || [], skip: [] },
            character_events: { keep: input.character_events || [], skip: [] },
            world_events: { keep: input.world_events || [], skip: [] },
            loot: { keep: input.loot || [], skip: [] },
            loot_removed: { keep: input.loot_removed || [], skip: [] },
            quests: { keep: input.quests || [], skip: [] },
            atlas: { action: 'keep' }
        };
    }
}
