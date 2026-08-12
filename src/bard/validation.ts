/**
 * Bard Validation - Batch validation system
 */

import { ValidationBatchInput, ValidationBatchOutput } from './types';
import { getMetadataClient } from './config';
import { monitor } from '../monitor';
import { getNpcHistory, getCharacterHistory, getOpenQuests, npcRepository, characterRepository, artifactRepository, inventoryRepository, questRepository, locationRepository } from '../db';
import { normalizeQuestStatus, QuestStatus } from '../db/types';
import { VALIDATION_PROMPT } from './prompts';
import { generateJson } from './llm/generate';
import { reassessNpcMoralWeights, MoralReassessmentCandidate } from './moralReassessment';

// Threshold above which an npc_event goes through the second pass that reassesses
// the motive (src/bard/moralReassessment.ts) — deliberately low so it also catches
// serious INTERACTION/COMBAT events, not just BETRAYAL/DEATH. Rare by construction: most
// sessions have no NPC events above this threshold.
const MORAL_REASSESSMENT_THRESHOLD = 3;

// ============================
// ID-First Resolution System
// ============================

type EntityLookupFn<T> = (campaignId: number, id: string) => T | null;

interface IdResolutionConfig<T, E> {
    events: E[];
    campaignId: number;
    lookupFn: EntityLookupFn<T>;
    entityType: string;
    eventNameField: keyof E;
    dbNameField: keyof T;
}

/**
 * Resolves ids into canonical names for a list of events.
 * ID-first pattern: it always tries to resolve by id first, then falls back to the name.
 * It mutates the events' name/title field directly when the id is resolved.
 * Logs every successful resolution in the format: [EntityType Event] 🎯 ID Match: id → canonicalName
 */
function resolveEntityIds<T extends object, E extends { id?: string }>(
    config: IdResolutionConfig<T, E>
): void {
    const { events, campaignId, lookupFn, entityType, eventNameField, dbNameField } = config;

    for (const event of events) {
        if (!event.id) continue;

        const entity = lookupFn(campaignId, event.id);
        if (entity) {
            const canonicalName = entity[dbNameField] as string;
            const currentName = event[eventNameField] as string;

            if (canonicalName && currentName !== canonicalName) {
                console.log(`[${entityType} Event] 🎯 ID Match: ${event.id} → ${canonicalName}`);
                (event as any)[eventNameField] = canonicalName;
            }
        }
    }
}

/**
 * Builds the prompt for batch validation
 */
function buildValidationPrompt(context: any, input: ValidationBatchInput): string {
    return VALIDATION_PROMPT(context, input);
}

/**
 * Targeted second pass: for the npc_events with a significant moral/ethical impact, it
 * recalibrates moral_impact/ethical_impact using the NPC's dossier description (the motive) +
 * recent history as context, instead of the categorical value assigned by the Analyst alone.
 * It mutates the items in place. A no-op when no event passes the threshold (the common case).
 */
async function applyMoralReassessment(
    campaignId: number,
    npcEventsKeep: any[],
    npcHistories: Record<string, string> | undefined
): Promise<void> {
    const flagged = npcEventsKeep.filter(evt =>
        Math.abs(evt.moral_impact || 0) >= MORAL_REASSESSMENT_THRESHOLD ||
        Math.abs(evt.ethical_impact || 0) >= MORAL_REASSESSMENT_THRESHOLD
    );
    if (flagged.length === 0) return;

    const candidates: MoralReassessmentCandidate[] = flagged.map(evt => {
        const npc = npcRepository.getNpcEntry(campaignId, evt.name);
        return {
            name: evt.name,
            event: evt.event || '',
            type: evt.type || 'GENERIC',
            moral_impact: evt.moral_impact || 0,
            ethical_impact: evt.ethical_impact || 0,
            dossierDescription: npc?.description || '',
            recentHistory: npcHistories?.[evt.name] || ''
        };
    });

    console.log(`[Validator] 🎭 ${candidates.length} evento/i NPC sopra soglia impatto (>=${MORAL_REASSESSMENT_THRESHOLD}), avvio reassessment movente...`);
    const reassessed = await reassessNpcMoralWeights(candidates);
    const byName = new Map(reassessed.map(r => [r.name.toLowerCase(), r]));

    for (const evt of flagged) {
        const revised = byName.get(evt.name.toLowerCase());
        if (!revised) continue;
        evt.moral_impact = revised.moral_impact;
        evt.ethical_impact = revised.ethical_impact;
    }
}

/**
 * UNIFIED BATCH VALIDATOR - optimized for cost
 */
export async function validateBatch(
    campaignId: number,
    input: ValidationBatchInput
): Promise<ValidationBatchOutput> {

    const context: any = {};

    // ============================
    // ID-First Resolution Phase
    // ============================
    // Resolves ALL the ids into canonical names BEFORE building the context.
    // This guarantees that the history lookup and the prompt use consistent names.

    // 1. NPC Events - ID Resolution
    if (input.npc_events && input.npc_events.length > 0) {
        resolveEntityIds({
            events: input.npc_events,
            campaignId,
            lookupFn: npcRepository.getNpcByShortId,
            entityType: 'NPC',
            eventNameField: 'name',
            dbNameField: 'name'
        });
    }

    // 2. Character Events - ID Resolution (usa User ID → character_name)
    if (input.character_events && input.character_events.length > 0) {
        for (const event of input.character_events) {
            if (!event.id) continue;
            const profile = characterRepository.getUserProfile(event.id, campaignId);
            if (profile?.character_name && event.name !== profile.character_name) {
                console.log(`[Character Event] 🎯 ID Match: ${event.id} → ${profile.character_name}`);
                event.name = profile.character_name;
            }
        }
    }

    // 3. Artifact Events - ID Resolution
    if (input.artifact_events && input.artifact_events.length > 0) {
        resolveEntityIds({
            events: input.artifact_events,
            campaignId,
            lookupFn: artifactRepository.getArtifactByShortId,
            entityType: 'Artifact',
            eventNameField: 'name',
            dbNameField: 'name'
        });
    }

    // 4. Quest - ID Resolution
    if (input.quests && input.quests.length > 0) {
        resolveEntityIds({
            events: input.quests,
            campaignId,
            lookupFn: questRepository.getQuestByShortId,
            entityType: 'Quest',
            eventNameField: 'title',
            dbNameField: 'title'
        });
    }

    // 5. Loot - ID Resolution
    if (input.loot && input.loot.length > 0) {
        resolveEntityIds({
            events: input.loot,
            campaignId,
            lookupFn: inventoryRepository.getInventoryItemByShortId,
            entityType: 'Loot',
            eventNameField: 'name',
            dbNameField: 'item_name'
        });
    }

    // 6. Loot Removed - ID Resolution
    if (input.loot_removed && input.loot_removed.length > 0) {
        resolveEntityIds({
            events: input.loot_removed,
            campaignId,
            lookupFn: inventoryRepository.getInventoryItemByShortId,
            entityType: 'Loot Removed',
            eventNameField: 'name',
            dbNameField: 'item_name'
        });
    }

    // 7. World Events - ID Resolution (location-based)
    // World events possono riferirsi a location tramite ID
    if (input.world_events && input.world_events.length > 0) {
        for (const event of input.world_events) {
            if (!event.id) continue;
            const location = locationRepository.getAtlasEntryByShortId(campaignId, event.id);
            if (location) {
                const locationName = `${location.macro_location} - ${location.micro_location}`;
                console.log(`[World Event] 🎯 ID Match: ${event.id} → ${locationName}`);
                // World events have no 'name' field, but the ID is kept for reference
            }
        }
    }

    // ============================
    // Context Building Phase
    // ============================
    // Builds the historical context using the ALREADY canonicalized names.

    // NPC History Context
    if (input.npc_events && input.npc_events.length > 0) {
        context.npcHistories = {};
        const processedNpcs = new Set<string>();

        for (const event of input.npc_events) {
            if (processedNpcs.has(event.name)) continue;
            processedNpcs.add(event.name);

            const history = getNpcHistory(campaignId, event.name).slice(-10);
            if (history.length > 0) {
                context.npcHistories[event.name] = history.map((h: any) =>
                    `[${h.event_type}] ${h.description}`
                ).join('; ');
            }
        }
    }

    // Character History Context
    if (input.character_events && input.character_events.length > 0) {
        context.charHistories = {};
        const processedChars = new Set<string>();

        for (const event of input.character_events) {
            if (processedChars.has(event.name)) continue;
            processedChars.add(event.name);

            const history = getCharacterHistory(campaignId, event.name).slice(-3);
            if (history.length > 0) {
                context.charHistories[event.name] = history.map((h: any) =>
                    `[${h.event_type}] ${h.description}`
                ).join('; ');
            }
        }
    }

    // Artifact History Context
    if (input.artifact_events && input.artifact_events.length > 0) {
        context.artifactHistories = {};
        const processedArtifacts = new Set<string>();

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

    // Quest Context
    if (input.quests && input.quests.length > 0) {
        context.existingQuests = getOpenQuests(campaignId).map((q: any) => q.title);
    }

    const prompt = buildValidationPrompt(context, input);

    const startAI = Date.now();
    try {
        const ai = await generateJson({
            route: await getMetadataClient(),
            label: 'metadata',
            system: "You are the Archive Keeper of a D&D campaign. Validate data in batch. Answer ONLY with valid JSON, keeping the rewritten texts in the SAME language as the input data.",
            prompt,
            lightModel: true,
            maxTokensNative: 12000,
            // Batch data validation = a simple classification task, a textbook case
            // for a low effort/thinking level (see GenerateParams.reasoningEffort).
            reasoningEffort: 'low'
        });

        console.log(`[Validator] Validazione completata in ${ai.latencyMs}ms (${ai.usage.input}+${ai.usage.output} tokens)`);

        const result = ai.parsed || {};

        // Normalize Quests with robust fallback logic
        const normalizeStatus = (s?: string): QuestStatus => {
            return normalizeQuestStatus(s) || QuestStatus.OPEN;
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
                        ethical_impact: outItem.ethical_impact ?? match.ethical_impact,
                        faction_id: outItem.faction_id ?? match.faction_id // 🆕 Preserve Faction ID
                    };
                }
                return outItem;
            });
        };

        const npcEventsKeep = mergeValidationResults(result.npc_events?.keep || [], input.npc_events || []);
        await applyMoralReassessment(campaignId, npcEventsKeep, context.npcHistories);

        return {
            npc_events: {
                keep: npcEventsKeep,
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
        monitor.logAIRequestWithCost('metadata', 'openai', 'gpt-4o-mini', 0, 0, 0, Date.now() - startAI, true);

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
