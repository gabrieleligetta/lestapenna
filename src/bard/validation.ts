/**
 * Bard Validation - Batch validation system
 */

import { ValidationBatchInput, ValidationBatchOutput } from './types';
import { metadataClient, METADATA_PROVIDER, METADATA_MODEL } from './config';
import { monitor } from '../monitor';
import { getNpcHistory, getCharacterHistory, getOpenQuests, npcRepository, characterRepository, artifactRepository, inventoryRepository, questRepository } from '../db';
import { QuestStatus } from '../db/types';
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

    // 1. NPC History Context
    if (input.npc_events && input.npc_events.length > 0) {
        context.npcHistories = {};

        // Use a map to avoid duplicate lookups
        const processedNpcs = new Set<string>();

        for (const event of input.npc_events) {
            if (processedNpcs.has(event.name)) continue;
            processedNpcs.add(event.name);

            let canonicalName = event.name;

            // Try to resolve by ID first if available
            if (event.id) {
                const npc = npcRepository.getNpcByShortId(campaignId, event.id);
                if (npc) {
                    canonicalName = npc.name;
                }
            }

            const history = getNpcHistory(campaignId, canonicalName).slice(-10);
            if (history.length > 0) {
                context.npcHistories[event.name] = history.map((h: any) =>
                    `[${h.event_type}] ${h.description}`
                ).join('; ');
            }
        }
    }

    // 2. Character History Context
    if (input.character_events && input.character_events.length > 0) {
        context.charHistories = {};
        const processedChars = new Set<string>();

        for (const event of input.character_events) {
            if (processedChars.has(event.name)) continue;
            processedChars.add(event.name);

            let canonicalName = event.name;

            // Try to resolve by ID (User ID for PCs) if available
            if (event.id) {
                const profile = characterRepository.getUserProfile(event.id, campaignId);
                if (profile && profile.character_name) {
                    canonicalName = profile.character_name;
                }
            }

            const history = getCharacterHistory(campaignId, canonicalName).slice(-3);
            if (history.length > 0) {
                context.charHistories[event.name] = history.map((h: any) =>
                    `[${h.event_type}] ${h.description}`
                ).join('; ');
            }
        }
    }

    // 3. Artifact History Context
    if (input.artifact_events && input.artifact_events.length > 0) {
        context.artifactHistories = {};
        const processedArtifacts = new Set<string>();

        // Pre-process to resolve IDs
        for (const event of input.artifact_events) {
            // Try to resolve by ID first
            if (event.id) {
                const artifact = artifactRepository.getArtifactByShortId(campaignId, event.id);
                if (artifact) {
                    event.name = artifact.name; // Canonicalize Name
                }
            }
        }

        for (const event of input.artifact_events) {
            if (processedArtifacts.has(event.name)) continue;
            processedArtifacts.add(event.name);

            const history = artifactRepository.getArtifactHistory(campaignId, event.name).slice(-5);
            if (history.length > 0) {
                context.artifactHistories[event.name] = history.map((h: any) =>
                    `[${h.event_type}] ${h.description}`
                ).join('; ');
            }
        }
    }

    // 4. Quest Context (Resolve IDs)
    if (input.quests && input.quests.length > 0) {
        for (const q of input.quests) {
            if (q.id) {
                const quest = questRepository.getQuestByShortId(campaignId, q.id);
                if (quest) {
                    q.title = quest.title; // Canonicalize Title
                }
            }
        }
        context.existingQuests = getOpenQuests(campaignId).map((q: any) => q.title);
    }

    // 5. Loot Context (Resolve IDs)
    if (input.loot && input.loot.length > 0) {
        for (const item of input.loot) {
            if (item.id) {
                const invItem = inventoryRepository.getInventoryItemByShortId(campaignId, item.id);
                if (invItem) {
                    item.name = invItem.item_name; // Canonicalize Name
                }
            }
        }
    }

    // 6. World Events Context (Resolve IDs)
    if (input.world_events && input.world_events.length > 0) {
        // Note: World events usually don't have a specific "name" field like others, 
        // but if they refer to a location ID, we might want to resolve it if the event structure supported it.
        // However, the current input structure is { id?: string; event: string; type: string }.
        // The ID here likely refers to an Atlas Entry (Location).
        // We can't easily "canonicalize" the event text, but we pass the ID to the prompt.
        // Effectively, the prompt sees [ID: xxxxx] and knows what it is.
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

        // Normalize Quests with robust fallback logic
        const normalizeStatus = (s?: string): QuestStatus => {
            if (!s) return QuestStatus.OPEN;
            const upper = s.toUpperCase();
            if (['IN CORSO', 'IN_PROGRESS', 'PROGRESS'].includes(upper)) return QuestStatus.IN_PROGRESS;
            if (['COMPLETED', 'DONE', 'COMPLETATA', 'SUCCEEDED'].includes(upper)) return QuestStatus.COMPLETED;
            if (['FAILED', 'FALLITA'].includes(upper)) return QuestStatus.FAILED;
            return QuestStatus.OPEN;
        };

        let normalizedQuests;
        if (result.quests && result.quests.keep) {
            normalizedQuests = {
                keep: result.quests.keep.map((q: any) => {
                    if (typeof q === 'string') return { title: q, description: '', status: QuestStatus.OPEN };
                    return { ...q, status: normalizeStatus(q.status) };
                }),
                skip: result.quests.skip || []
            };
        } else if (Array.isArray(result.quests)) {
            // Fallback if AI returns flat array instead of {keep, skip}
            normalizedQuests = {
                keep: result.quests.map((q: any) => {
                    if (typeof q === 'string') return { title: q, description: '', status: QuestStatus.OPEN };
                    return { ...q, status: normalizeStatus(q.status) };
                }),
                skip: []
            };
        } else {
            // Fallback if AI omits field or returns unknown format: Keep everything from input
            normalizedQuests = {
                keep: (input.quests || []).map((q: any) => {
                    if (typeof q === 'string') return { title: q, description: '', status: QuestStatus.OPEN };
                    return { ...q, status: normalizeStatus(q.status) };
                }),
                skip: []
            };
            console.log(`[Validator] ⚠️ Campo 'quests' mancante o malformato nella risposta IA. Applicato fallback conservativo.`);
        }

        // Helper to merge Validator output (Description/Type) with Analyst input (ID/Alignments)
        const mergeValidationResults = (outputItems: any[], inputItems: any[], nameField: string = 'name') => {
            if (!outputItems || !inputItems) return outputItems;
            return outputItems.map(outItem => {
                // Try to find matching input item by name (case-insensitive)
                const match = inputItems.find(inItem =>
                    inItem[nameField] && outItem[nameField] &&
                    inItem[nameField].toLowerCase() === outItem[nameField].toLowerCase()
                );

                if (match) {
                    return {
                        ...outItem,
                        // Preserve Critical Metadata from Analyst if missing in Validator output
                        id: outItem.id || match.id,
                        moral_impact: outItem.moral_impact ?? match.moral_impact,
                        ethical_impact: outItem.ethical_impact ?? match.ethical_impact
                    };
                }
                return outItem;
            });
        };

        return {
            npc_events: {
                keep: mergeValidationResults(result.npc_events?.keep || [], input.npc_events || []),
                skip: result.npc_events?.skip || []
            },
            character_events: {
                keep: mergeValidationResults(result.character_events?.keep || [], input.character_events || []),
                skip: result.character_events?.skip || []
            },
            world_events: result.world_events || { keep: input.world_events || [], skip: [] },
            artifact_events: {
                keep: mergeValidationResults(result.artifact_events?.keep || [], input.artifact_events || []),
                skip: result.artifact_events?.skip || []
            },
            loot: {
                keep: mergeValidationResults(result.loot?.keep || result.loot || [], input.loot || []), // Handles both {keep: []} and [] formats
                skip: result.loot?.skip || []
            },
            loot_removed: {
                keep: mergeValidationResults(result.loot_removed?.keep || result.loot_removed || [], input.loot_removed || []),
                skip: result.loot_removed?.skip || []
            },
            quests: {
                keep: mergeValidationResults(normalizedQuests.keep, input.quests || [], 'title'),
                skip: normalizedQuests.skip
            },
            atlas: result.atlas || { action: 'keep' }
        };

    } catch (e: any) {
        console.error('[Validator] Errore batch validation:', e);
        monitor.logAIRequestWithCost('metadata', METADATA_PROVIDER, METADATA_MODEL, 0, 0, 0, Date.now() - startAI, true);

        return {
            npc_events: { keep: input.npc_events || [], skip: [] },
            character_events: { keep: input.character_events || [], skip: [] },
            world_events: { keep: input.world_events || [], skip: [] },
            artifact_events: { keep: input.artifact_events || [], skip: [] },
            loot: { keep: input.loot || [], skip: [] },
            loot_removed: { keep: input.loot_removed || [], skip: [] },
            quests: { keep: input.quests || [], skip: [] },
            atlas: { action: 'keep' }
        };
    }
}
