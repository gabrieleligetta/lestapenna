/**
 * Ingestion Service - RAG updates, batch validation, and database synchronization
 */

import { TextChannel } from 'discord.js';
import { sessionPhaseManager } from '../../services/SessionPhaseManager';
import {
    updateSessionTitle,
    addCharacterEvent,
    addNpcEvent,
    addWorldEvent,
    addLoot,
    removeLoot,
    addQuest,
    updateNpcEntry,
    getNpcEntry,
    updateLocation,
    updateAtlasEntry,
    upsertMonster,
    updateSessionPresentNPCs,
    markCharacterDirtyByName,
    markNpcDirty,
    markAtlasDirty,
    clearSessionDerivedData,
    addSessionLog,
    addInventoryEvent,
    addQuestEvent,
    addBestiaryEvent,
    addAtlasEvent,
    factionRepository,
    locationRepository,
    npcRepository,
    getNpcByAlias,
    getSessionStartTime,
    getNpcHistory,
    getAtlasEntryFull,
    upsertArtifact,
    addArtifactEvent,
    getArtifactByName,
    getArtifactByShortId,
    markArtifactDirty,
    getFaction,
    normalizeQuestStatus,
    normalizeQuestType,
    QuestStatus,
    questLifecycleRepository,
    questRepository
} from '../../db';
import { t, getCampaignLocale, getGuildLocale, eventTypeLabel } from '../../i18n';
// Import from the repository FILE (not from the barrel): same path as the old
// dynamic imports, so any test mocks on the module stay valid.
import { inventoryRepository } from '../../db/repositories/InventoryRepository';
import {
    ingestSessionComplete,
    validateBatch,
    ingestBioEvent,
    ingestWorldEvent,
    ingestLootEvent,
    ingestGenericEvent,
    deduplicateItemBatch,
    reconcileItemName,
    deduplicateNpcBatch,
    reconcileNpcName,
    smartMergeBios,
    reconcileLocationName,
    deduplicateLocationBatch,
    deduplicateMonsterBatch,
    reconcileMonsterName,
    reconcileQuestTitle,
    syncAllDirtyNpcs,
    syncAllDirtyCharacters,
    syncAllDirtyAtlas,
    syncAllDirtyBestiary,
    syncAllDirtyInventory,
    syncAllDirtyQuests,
    syncAllDirtyFactions,
    syncAllDirtyArtifacts,
    cleanEntityName
} from '../../bard';
import { invalidateManifesto } from '../../bard/manifesto';

const SIGNIFICANT_WORD_MIN_LENGTH = 4;
const NEAR_DUPLICATE_JACCARD_THRESHOLD = 0.55;

function significantWords(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= SIGNIFICANT_WORD_MIN_LENGTH)
    );
}

/**
 * Cheap normalized word-overlap (Jaccard) check to avoid re-logging a BACKGROUND
 * npc_history row whose text substantially restates an existing history entry.
 */
export function isNearDuplicateOfExistingHistory(text: string, existingRows: Array<{ description?: string }>): boolean {
    const words = significantWords(text);
    if (words.size === 0) return false;
    for (const row of existingRows) {
        if (!row.description) continue;
        const otherWords = significantWords(row.description);
        if (otherWords.size === 0) continue;
        let intersection = 0;
        for (const w of words) if (otherWords.has(w)) intersection++;
        const union = words.size + otherWords.size - intersection;
        const jaccard = union > 0 ? intersection / union : 0;
        if (jaccard >= NEAR_DUPLICATE_JACCARD_THRESHOLD) return true;
    }
    return false;
}

export class IngestionService {
    /**
     * Ingests session summary into RAG
     */
    async ingestSummary(sessionId: string, summary: any): Promise<void> {
        await ingestSessionComplete(sessionId, summary);
        console.log(`[Monitor] 🧠 Memoria RAG aggiornata`);
    }

    /**
     * Updates session title in database
     */
    updateSessionTitle(sessionId: string, title: string): void {
        updateSessionTitle(sessionId, title);
    }

    /**
     * Clears all derived data for a session (history, loot, quests)
     */
    clearSessionData(sessionId: string): void {
        clearSessionDerivedData(sessionId);
    }

    /**
     * Processes and validates batch events, then writes to database
     */
    async processBatchEvents(
        campaignId: number,
        sessionId: string,
        result: any,
        channel?: TextChannel,
        isSilent: boolean = false
    ): Promise<void> {
        // Prepare batch input
        const batchInput: any = {};

        // Fetch session timestamp for history records
        const sessionStartTime = getSessionStartTime(sessionId) || Date.now();

        if (result.character_growth?.length) batchInput.character_events = result.character_growth;
        if (result.npc_events?.length) batchInput.npc_events = result.npc_events;
        if (result.world_events?.length) batchInput.world_events = result.world_events;
        if (result.artifact_events?.length) batchInput.artifact_events = result.artifact_events;
        if (result.loot?.length) batchInput.loot = result.loot;
        if (result.loot_removed?.length) batchInput.loot_removed = result.loot_removed;
        // The new lifecycle is already a specialized evidence-based step:
        // it must not go back into the generic Validator, which historically
        // could discard or downgrade COMPLETED to IN_PROGRESS.
        if (!result.quest_lifecycle && result.quests?.length) batchInput.quests = result.quests;

        // 📍 PHASE: VALIDATING
        sessionPhaseManager.setPhase(sessionId, 'VALIDATING');

        // Execute batch validation
        let validated: any = {
            npc_events: { keep: [], skip: [] },
            character_events: { keep: [], skip: [] },
            world_events: { keep: [], skip: [] },
            artifact_events: { keep: [], skip: [] },
            loot: { keep: [], skip: [] },
            loot_removed: { keep: [], skip: [] },
            quests: { keep: [], skip: [] }
        };
        if (Object.keys(batchInput).length > 0) {
            console.log('[Validator] 🛡️ Validazione batch in corso...');
            validated = await validateBatch(campaignId, batchInput);

            // Log statistics
            const totalInput =
                (batchInput.npc_events?.length || 0) +
                (batchInput.character_events?.length || 0) +
                (batchInput.world_events?.length || 0) +
                (batchInput.artifact_events?.length || 0) +
                (batchInput.loot?.length || 0) +
                (batchInput.quests?.length || 0);

            const totalKept =
                (validated.npc_events.keep.length) +
                (validated.character_events.keep.length) +
                (validated.world_events.keep.length) +
                (validated.artifact_events.keep.length) +
                (validated.loot.keep.length) +
                (validated.loot_removed.keep.length) +
                (validated.quests.keep.length);

            const totalSkipped = totalInput - totalKept;
            const filterRate = totalInput > 0 ? Math.round((totalSkipped / totalInput) * 100) : 0;

            console.log(`[Validator] ✅ Validazione completata:`);
            console.log(`  - Accettati: ${totalKept}/${totalInput}`);
            console.log(`  - Filtrati: ${totalSkipped} (${filterRate}%)`);

            const factionsCount = (result.faction_updates?.length || 0);
            const artifactsCount = (result.artifacts?.length || 0);
            if (factionsCount > 0 || artifactsCount > 0) {
                console.log(`  - Rilevati: ${factionsCount} Fazioni, ${artifactsCount} Artefatti (Processati separatamente)`);
            }
        }

        if (result.quest_lifecycle?.decisions) {
            await this.processQuestLifecycle(
                campaignId,
                sessionId,
                result.quest_lifecycle.decisions,
                sessionStartTime
            );
        }

        // 🆕 Process Faction Updates (MOVED FIRST to ensure IDs exist)
        if (result.faction_updates?.length) {
            console.log(`[Ingestion] ⚔️ Salvataggio ${result.faction_updates.length} aggiornamenti fazioni...`);
            await this.processFactionUpdates(campaignId, sessionId, result.faction_updates, sessionStartTime);
        }



        // 🆕 Process Party Alignment (via addFactionEvent on party faction)
        if (result.party_alignment_change) {
            const { moral_impact, ethical_impact, reason, id } = result.party_alignment_change;
            if (moral_impact || ethical_impact) {
                console.log(`[Ingestion] ⚖️ Allineamento Party: M:${moral_impact || 0} / E:${ethical_impact || 0} (${reason})`);

                // Resolve party faction: try short_id first, then getPartyFaction
                let partyFaction = null;
                if (id) {
                    partyFaction = factionRepository.getFactionByShortId(campaignId, id);
                }
                if (!partyFaction) {
                    partyFaction = factionRepository.getPartyFaction(campaignId);
                }

                if (partyFaction) {
                    // addFactionEvent handles everything: inserts faction_history,
                    // updates factions.moral_score/ethical_score, recalculates labels,
                    // and if is_party=1 also updates campaigns.party_moral_score/party_ethical_score
                    factionRepository.addFactionEvent(
                        campaignId,
                        partyFaction.name,
                        sessionId,
                        t(getCampaignLocale(campaignId), 'ingest.partyAlignment', { reason }),
                        'GENERIC',
                        false,
                        0, // reputation_change_value
                        moral_impact || 0,
                        ethical_impact || 0,
                        sessionStartTime
                    );
                    console.log(`[Ingestion] 🎭 Fazione Party aggiornata via addFactionEvent: ${partyFaction.name}`);
                } else {
                    console.warn(`[Ingestion] ⚠️ Party faction non trovata per campagna ${campaignId}`);
                }

                // World event for audit trail
                addWorldEvent(
                    campaignId,
                    sessionId,
                    t(getCampaignLocale(campaignId), 'ingest.partyAlignmentChanged', {
                        moral: moral_impact || 0, ethical: ethical_impact || 0, reason,
                    }),
                    'POLITICS',
                    undefined,
                    false,
                    sessionStartTime
                );
            }
        }

        // Process NPC dossier updates (metadata)
        if (result.npc_dossier_updates?.length) {
            await this.processNpcDossierUpdates(campaignId, sessionId, result.npc_dossier_updates, sessionStartTime);
        }

        // Process location updates (metadata)
        if (result.location_updates?.length) {
            await this.processLocationUpdates(campaignId, sessionId, result.location_updates, sessionStartTime);
        }

        // Process monsters
        await this.processMonsters(campaignId, sessionId, result.monsters, sessionStartTime);

        // 🆕 Process Faction Affiliations (Process AFTER entities are created)
        if (result.faction_affiliations?.length) {
            console.log(`[Ingestion] 🤝 Salvataggio ${result.faction_affiliations.length} affiliazioni...`);
            await this.processFactionAffiliations(campaignId, sessionId, result.faction_affiliations, sessionStartTime);
        }

        // Process present NPCs
        if (result.present_npcs?.length) {
            updateSessionPresentNPCs(sessionId, result.present_npcs);
        }

        // 🆕 Process Logs (Bullet points)
        if (result.log?.length) {
            console.log(`[Ingestion] 📝 Salvataggio ${result.log.length} voci di log...`);
            for (const entry of result.log) {
                addSessionLog(sessionId, entry);
                // Also ingest in RAG for better semantic search of specific actions
                await ingestGenericEvent(campaignId, sessionId, `[LOG AZIONE] ${entry}`, [], 'SESSION_LOG', sessionStartTime);
            }
        }

        // 🆕 Process Travel Sequence
        if (result.travel_sequence?.length) {
            console.log(`[Ingestion] 🗺️ Salvataggio ${result.travel_sequence.length} spostamenti...`);
            // Preventive cleanup: processBatchEvents can be called more than once on the same
            // session (e.g. $racconta without --reindex reuses the AI cache). travel_sequence
            // is the definitive source for the location history, so it is always replaced.
            locationRepository.clearSessionLocationHistory(sessionId);
            for (const travel of result.travel_sequence) {
                updateLocation(campaignId, travel.macro, travel.micro, sessionId, travel.reason, sessionStartTime);
            }
        }

        await this.processNpcLastSeenLocations(
            campaignId,
            result.present_npcs || [],
            result.npc_locations || [],
            result.travel_sequence || []
        );

        // 🆕 Process Artifacts (Magical/Legendary Items)
        if (result.artifacts?.length) {
            console.log(`[Ingestion] ✨ Salvataggio ${result.artifacts.length} artefatti...`);
            await this.processArtifacts(campaignId, sessionId, result.artifacts, sessionStartTime);
        }

        // Process validated events (NOW CALLED AFTER UPDATES)
        if (validated) {
            await this.processValidatedEvents(campaignId, sessionId, validated, sessionStartTime);
        }

        // 📍 PHASE: SYNCING
        sessionPhaseManager.setPhase(sessionId, 'SYNCING');

        // Sync dirty entities to RAG
        await this.syncDirtyEntities(campaignId, validated, result, channel, isSilent);
        invalidateManifesto(campaignId);
    }

    /**
     * Updates NPC last_seen_location using explicit per-NPC locations from the Analyst.
     * The location must resolve to an existing atlas entry; otherwise it is skipped.
     */
    private async processNpcLastSeenLocations(
        campaignId: number,
        presentNpcs: string[],
        npcLocations: Array<{ name: string; location_id?: string; macro?: string; micro?: string }>,
        travelSequence: Array<{ macro: string; micro: string; reason?: string }>
    ): Promise<void> {
        const locationsByNpc = new Map<string, { name: string; location_id?: string; macro?: string; micro?: string }>();
        const presentSet = new Set((presentNpcs || []).map(name => name.toLowerCase()));

        for (const loc of npcLocations || []) {
            if (!loc?.name) continue;
            if (presentSet.size > 0 && !presentSet.has(loc.name.toLowerCase())) continue;
            locationsByNpc.set(loc.name.toLowerCase(), loc);
        }

        // Backward-compatible safe fallback for old cached summaries: only stamp everyone
        // when the session has exactly one travel location. Multi-location sessions require
        // explicit per-NPC data to avoid assigning the party's final location to everyone.
        if (locationsByNpc.size === 0 && presentNpcs?.length && travelSequence?.length === 1) {
            const onlyLocation = travelSequence[0];
            for (const npcName of presentNpcs) {
                locationsByNpc.set(npcName.toLowerCase(), {
                    name: npcName,
                    macro: onlyLocation.macro,
                    micro: onlyLocation.micro
                });
            }
            console.log(`[NPC] 📍 Fallback posizione: sessione a luogo singolo (${onlyLocation.macro} - ${onlyLocation.micro})`);
        }

        if (locationsByNpc.size === 0) return;

        console.log(`[NPC] 📍 Risoluzione ultime posizioni per ${locationsByNpc.size} NPC...`);


        for (const npcLoc of locationsByNpc.values()) {
            const npc = getNpcEntry(campaignId, npcLoc.name) || getNpcByAlias(campaignId, npcLoc.name);
            if (!npc) {
                console.warn(`[NPC] ⚠️ Posizione ignorata per "${npcLoc.name}": NPC non trovato nel dossier.`);
                continue;
            }

            const atlasEntry = await this.resolveNpcAtlasLocation(campaignId, npcLoc);
            if (!atlasEntry) {
                const requested = [npcLoc.macro, npcLoc.micro].filter(Boolean).join(' - ') || npcLoc.location_id || 'sconosciuta';
                console.warn(`[NPC] ⚠️ Posizione ignorata per ${npc.name}: luogo non presente in atlante (${requested}).`);
                continue;
            }

            const location = [atlasEntry.macro_location, atlasEntry.micro_location].filter(Boolean).join(' - ');
            npcRepository.updateNpcLastSeenLocation(campaignId, npc.name, location);
            markNpcDirty(campaignId, npc.name);
        }
    }

    private async resolveNpcAtlasLocation(
        campaignId: number,
        npcLoc: { location_id?: string; macro?: string; micro?: string }
    ): Promise<any | null> {

        if (npcLoc.location_id) {
            const byId = locationRepository.getAtlasEntryByShortId(campaignId, npcLoc.location_id);
            if (byId) return byId;
        }

        if (!npcLoc.macro || !npcLoc.micro) return null;

        const cleanMacro = cleanEntityName(npcLoc.macro).name;
        const cleanMicro = cleanEntityName(npcLoc.micro).name;

        const exact = locationRepository.getAtlasEntryFull(campaignId, cleanMacro, cleanMicro);
        if (exact) return exact;

        const reconciled = await reconcileLocationName(campaignId, cleanMacro, cleanMicro);
        if (!reconciled) return null;

        return locationRepository.getAtlasEntryFull(campaignId, reconciled.canonicalMacro, reconciled.canonicalMicro)
            || reconciled.existingEntry
            || null;
    }

    /**
     * Processes validated events
     */
    private async processValidatedEvents(campaignId: number, sessionId: string, validated: any, timestamp: number): Promise<void> {
        // Character events
        for (const evt of validated.character_events.keep) {
            const safeDesc = evt.event || "Evento significativo registrato.";
            console.log(`[PG] ➕ ${evt.name}: ${safeDesc}`);

            // 🆕 Resolve Faction ID if present (Fix for FK errors)
            let fixedFactionId = evt.faction_id;
            if (fixedFactionId) {
                const faction = factionRepository.getFactionByShortId(campaignId, fixedFactionId);
                if (faction) {
                    fixedFactionId = faction.id;
                } else if (typeof fixedFactionId !== 'number') {
                    // If it's a string ID that we couldn't resolve, fallback to null to avoid FK error
                    // Try name?
                    const fByName = factionRepository.getFaction(campaignId, fixedFactionId);
                    if (fByName) fixedFactionId = fByName.id;
                    else fixedFactionId = null;
                }
            }

            // Signature: (campaignId: number, charName: string, sessionId: string, description: string, type: string, isManual, timestamp, moral, ethical, factionId)
            addCharacterEvent(
                campaignId,
                evt.name,
                sessionId,
                safeDesc,
                evt.type || 'GROWTH',
                false,
                timestamp,
                evt.moral_impact || 0,
                evt.ethical_impact || 0,
                fixedFactionId
            );
            // Signature: (campaignId: number, sessionId: string, charName: string, event: string, type: string, timestamp)
            await ingestBioEvent(campaignId, sessionId, evt.name, safeDesc, 'PG', timestamp);
            markCharacterDirtyByName(campaignId, evt.name);
        }

        // NPC events
        if (validated.npc_events?.keep?.length) {
                for (const evt of validated.npc_events.keep) {
                const safeDesc = evt.event || "Interazione rilevante registrata.";
                let npcName = evt.name;

                // 🆕 ID-First Lookup logic
                if (evt.id) {
                    const existing = npcRepository.getNpcByShortId(campaignId, evt.id);
                    if (existing) {
                        console.log(`[NPC Event] 🎯 ID Match event: ${evt.id} → ${existing.name}`);
                        npcName = existing.name;
                    }
                }

                // 🆕 Resolve Faction ID if present
                let fixedFactionId = evt.faction_id;
                if (fixedFactionId) {
                    const faction = factionRepository.getFactionByShortId(campaignId, fixedFactionId);
                    if (faction) {
                        fixedFactionId = faction.id;
                    } else if (typeof fixedFactionId !== 'number') {
                        const fByName = factionRepository.getFaction(campaignId, fixedFactionId);
                        if (fByName) fixedFactionId = fByName.id;
                        else fixedFactionId = null;
                    }
                }

                console.log(`[NPC] ➕ ${npcName}: ${safeDesc}`);
                // Signature: (campaignId: number, npcName: string, sessionId: string, description: string, type: string, isManual, timestamp, moral, ethical)
                addNpcEvent(
                    campaignId,
                    npcName,
                    sessionId,
                    safeDesc,
                    evt.type || 'EVENT',
                    false,
                    timestamp,
                    evt.moral_impact || 0,
                    evt.ethical_impact || 0,
                    fixedFactionId
                );
                // Signature: (campaignId: number, sessionId: string, charName: string, event: string, type: string, timestamp)
                await ingestBioEvent(campaignId, sessionId, npcName, safeDesc, 'NPC', timestamp);
                // Also mark dirty
                markNpcDirty(campaignId, npcName);
            }
        }


        // World events
        for (const evt of validated.world_events.keep) {
            // Clean event text just in case it has weird metadata like "(Source: ...)" caught by NER?
            // Usually events are full sentences, so we be careful.
            // But if cleanEntityName finds extra info in parens at end, we might want to keep it as text?
            // actually cleanEntityName moves it to "extra".
            // Let's just strip it if it looks like metadata, OR keep it if it looks like context.
            // For World Events, we probably just want to sanitize leading/trailing.
            // But let's apply cleanEntityName to be consistent with "Entity (Extra)" pattern.
            const clean = cleanEntityName(evt.event);
            const safeDesc = clean.extra ? `${clean.name} (${clean.extra})` : clean.name || t(getCampaignLocale(campaignId), 'ingest.worldEventFallback');

            console.log(`[World] ➕ ${safeDesc}`);
            // Signature: (campaignId: number, sessionId: string | null, description: string, type: string, year?: number, manual, timestamp)
            addWorldEvent(campaignId, sessionId, safeDesc, evt.type || 'EVENT', undefined, false, timestamp);
            // Signature: (campaignId: number, sessionId: string, event: string, type: string, timestamp)
            await ingestWorldEvent(campaignId, sessionId, safeDesc, evt.type || 'EVENT', timestamp);
        }

        // 🆕 Artifact events
        if (validated.artifact_events?.keep?.length) {
            for (const evt of validated.artifact_events.keep) {
                const safeDesc = evt.event || t(getCampaignLocale(campaignId), 'ingest.artifactEventFallback');
                let artifactName = cleanEntityName(evt.name).name;

                // 🆕 ID-First Lookup logic
                if (evt.id) {
                    const existing = getArtifactByShortId(campaignId, evt.id);
                    if (existing) {
                        console.log(`[Artifact Event] 🎯 ID Match event: ${evt.id} → ${existing.name}`);
                        artifactName = existing.name;
                    }
                }

                console.log(`[Artifact Event] ➕ ${artifactName}: ${safeDesc} [${evt.type || 'GENERIC'}]`);
                addArtifactEvent(
                    campaignId,
                    artifactName,
                    sessionId,
                    safeDesc,
                    evt.type || 'GENERIC',
                    false,
                    timestamp
                );
                markArtifactDirty(campaignId, artifactName);
            }
        }

        // Loot (with reconciliation)
        if (validated.loot?.keep && validated.loot.keep.length > 0) {
            const dedupedLoot = await deduplicateItemBatch(validated.loot.keep);
            for (const item of dedupedLoot) {
                // Name Cleaning
                const clean = cleanEntityName(item.name);
                const itemName = clean.name;
                const itemDesc = clean.extra ? `${item.description || ''} (${clean.extra})`.trim() : item.description;

                const reconciled = await reconcileItemName(campaignId, { ...item, name: itemName });
                const finalName = reconciled ? reconciled.canonicalName : itemName;
                if (reconciled) console.log(`[Loot] 🔄 Riconciliato: "${item.name}" → "${finalName}"`);

                addLoot(campaignId, finalName, item.quantity || 1, sessionId, itemDesc, false, timestamp, item.category);

                // 🆕 History Tracking
                addInventoryEvent(campaignId, finalName, sessionId, t(getCampaignLocale(campaignId), 'ingest.lootAcquired', { desc: itemDesc || t(getCampaignLocale(campaignId), 'ingest.noDescription') }), 'LOOT', false, timestamp);

                // Skip simple currency from RAG
                const isSimpleCurrency = /^[\d\s]+(mo|monete?|oro|argent|ram|pezz)/i.test(finalName) && finalName.length < 30;
                if (!isSimpleCurrency) {
                    await ingestLootEvent(campaignId, sessionId, {
                        ...item,
                        name: finalName
                    }, timestamp);
                }
            }
        }

        // Lost loot
        if (validated.loot_removed?.keep && validated.loot_removed.keep.length > 0) {
            const dedupedLostLoot = await deduplicateItemBatch(validated.loot_removed.keep);
            for (const item of dedupedLostLoot) {
                const reconciled = await reconcileItemName(campaignId, item);
                const finalName = reconciled ? reconciled.canonicalName : item.name;
                if (reconciled) console.log(`[Loot] 🔄 Riconciliato: "${item.name}" → "${finalName}"`);

                removeLoot(campaignId, finalName, item.quantity || 1);

                // 🆕 History Tracking
                addInventoryEvent(campaignId, finalName, sessionId, t(getCampaignLocale(campaignId), 'ingest.lootRemoved', { desc: item.description || t(getCampaignLocale(campaignId), 'ingest.noDescription') }), 'USE', false, timestamp);

                // Also ingest in RAG to track WHY it was removed
                await ingestLootEvent(campaignId, sessionId, {
                    ...item,
                    name: t(getCampaignLocale(campaignId), 'ingest.removedName', { name: finalName })
                }, timestamp);
            }
        }

        // Legacy quest ingestion: kept for historical caches that lack
        // quest_lifecycle. New sessions only take the ID-first path above.
        for (const quest of validated.quests.keep || []) {
            // Handle both string and object formats for backward compatibility
            const rawTitle = typeof quest === 'string' ? quest : quest.title;
            const rawDesc = typeof quest === 'string' ? '' : quest.description;
            const status = typeof quest === 'string' ? 'OPEN' : (quest.status || 'OPEN');

            // Clean Title
            const clean = cleanEntityName(rawTitle);
            // Prepend extra info to description if found
            const description = clean.extra
                ? (rawDesc ? `[${clean.extra}] ${rawDesc}` : `[${clean.extra}]`)
                : rawDesc;

            // Cross-session reconciliation: quest titles drift a lot (same mission,
            // title rephrased by the AI). On a match with an existing quest, use its canonical title.
            let title = clean.name;
            try {
                const reconciled = await reconcileQuestTitle(campaignId, title, description || '');
                if (reconciled && reconciled.canonicalTitle !== title) {
                    console.log(`[Quest] 🔄 Riconciliata: "${title}" → "${reconciled.canonicalTitle}"`);
                    title = reconciled.canonicalTitle;
                }
            } catch (e) {
                console.error(`[Quest] ⚠️ Errore riconciliazione "${title}":`, e);
            }

            console.log(`[Quest] ➕ ${title} (${status})`);

            // Signature: (campaignId: number, title: string, sessionId?: string, description?: string, status?: string, type?: string, manual, timestamp)
            addQuest(campaignId, title, sessionId, description, status, quest.type || 'MAJOR', false, timestamp);

            // 🆕 History Tracking
            addQuestEvent(campaignId, title, sessionId, description || t(getCampaignLocale(campaignId), 'ingest.questUpdated', { status: eventTypeLabel(getCampaignLocale(campaignId), status) }), status === 'OPEN' ? 'PROGRESS' : status, false, timestamp);
        }
    }

    private async processQuestLifecycle(
        campaignId: number,
        sessionId: string,
        decisions: any[],
        timestamp: number
    ): Promise<void> {
        for (const decision of decisions) {
            if (!decision || decision.action === 'NO_CHANGE') continue;
            if (decision.action !== 'CREATE' && decision.action !== 'STATUS_CHANGE') {
                console.warn(`[Quest Lifecycle] Azione non canonica scartata: ${String(decision.action)}`);
                continue;
            }
            const proposedStatus = normalizeQuestStatus(decision.proposed_status);
            const proposedType = normalizeQuestType(decision.type);
            if (!proposedStatus || !proposedType) {
                console.warn(`[Quest Lifecycle] Enum non canonico scartato: ${JSON.stringify(decision)}`);
                continue;
            }

            const confidence = ['HIGH', 'MEDIUM', 'LOW'].includes(decision.confidence)
                ? decision.confidence
                : 'LOW';
            const action = decision.action;
            const existing = decision.id
                ? questRepository.getQuestByShortId(campaignId, decision.id)
                : null;
            if (
                action === 'STATUS_CHANGE' &&
                (!existing || normalizeQuestStatus(existing.status) === proposedStatus)
            ) continue;
            const suggestion = questLifecycleRepository.createSuggestion({
                campaignId,
                questId: existing?.id ?? null,
                sessionId,
                proposedAction: action,
                proposedTitle: existing?.title || decision.title,
                proposedDescription: decision.description || null,
                proposedStatus,
                proposedType,
                evidence: decision.evidence || decision.description || 'Evidenza non specificata.',
                confidence
            });

            if (suggestion.status !== 'PENDING' || confidence !== 'HIGH') continue;

            if (action === 'STATUS_CHANGE') {
                if (!existing?.short_id) continue;
                const updated = questRepository.applyAiStatusByShortId(
                    campaignId,
                    existing.short_id,
                    proposedStatus,
                    sessionId,
                    decision.description || decision.evidence || `Stato aggiornato a ${proposedStatus}.`,
                    timestamp
                );
                if (updated) {
                    questLifecycleRepository.resolveSuggestion(campaignId, suggestion.id, 'APPLIED');
                    console.log(`[Quest Lifecycle] ✅ ${updated.title}: ${existing.status} → ${updated.status}`);
                }
                continue;
            }

            // CREATE: a semantic match found at the last mile is not turned
            // into an update by title; it stays a proposal to review.
            const clean = cleanEntityName(decision.title);
            const reconciled = await reconcileQuestTitle(
                campaignId,
                clean.name,
                decision.description || ''
            );
            if (reconciled) {
                console.warn(`[Quest Lifecycle] ⚠️ CREATE "${clean.name}" somiglia a "${reconciled.canonicalTitle}": resta proposta.`);
                continue;
            }

            addQuest(
                campaignId,
                clean.name,
                sessionId,
                decision.description || '',
                proposedStatus,
                proposedType,
                false,
                timestamp
            );
            const created = questRepository.getQuestByTitle(campaignId, clean.name);
            if (created) {
                addQuestEvent(
                    campaignId,
                    created.title,
                    sessionId,
                    decision.description || `Quest aperta con stato ${proposedStatus}.`,
                    proposedStatus === QuestStatus.OPEN ? 'CREATED' : 'PROGRESS',
                    false,
                    timestamp
                );
                questLifecycleRepository.resolveSuggestion(campaignId, suggestion.id, 'APPLIED');
                console.log(`[Quest Lifecycle] 🆕 ${created.title} (${created.status})`);
            }
        }
    }

    /**
     * Processes NPC dossier updates
     */
    private async processNpcDossierUpdates(campaignId: number, sessionId: string, npcUpdates: any[], sessionStartTime: number): Promise<void> {
        console.log(`[NPC Dossier] 📋 Aggiornamento ${npcUpdates.length} schede NPC...`);

        const dedupedNpcs = await deduplicateNpcBatch(npcUpdates);
        for (const npc of dedupedNpcs as any[]) {
            if (npc.name && (npc.description || npc.role || npc.status)) {
                // Name Cleaning
                const clean = cleanEntityName(npc.name);
                const npcName = clean.name;
                const npcDesc = clean.extra ? `${npc.description} (Nota: ${clean.extra})` : npc.description;

                // 🆕 ID-First Lookup: If Analyst provided an ID, use it directly
                if (npc.id) {
                    const existingById = npcRepository.getNpcByShortId(campaignId, npc.id);
                    if (existingById) {
                        console.log(`[NPC Dossier] 🎯 ID Match: ${npc.id} → ${existingById.name}`);
                        const oldBio = existingById.description || '';
                        const mergedBio = await smartMergeBios(existingById.name, oldBio, npcDesc);
                        updateNpcEntry(
                            campaignId,
                            existingById.name,
                            mergedBio,
                            npc.role || existingById.role,
                            npc.status || existingById.status,
                            sessionId,
                            false,
                            npc.alignment_moral,
                            npc.alignment_ethical
                        );
                        markNpcDirty(campaignId, existingById.name);
                        this.persistBackgroundFactIfNew(campaignId, existingById.name, sessionId, npcDesc, sessionStartTime, getNpcHistory);
                        continue; // Skip reconciliation
                    }
                }

                // Fallback: Name-based reconciliation
                const reconciled = await reconcileNpcName(campaignId, npcName, npcDesc);
                if (reconciled?.isPlayerCharacter) {
                    console.log(`[NPC Dossier] 🎮 Skip PG rilevato in npc_dossier_updates: "${npcName}"`);
                    continue;
                }
                const finalName = reconciled ? reconciled.canonicalName : npcName;
                if (reconciled) console.log(`[NPC Dossier] 🔄 Riconciliato: "${npc.name}" → "${finalName}"`);

                // Get existing bio and merge with new one
                const existing = getNpcEntry(campaignId, finalName);
                const oldBio = existing?.description || '';
                const mergedBio = await smartMergeBios(finalName, oldBio, npcDesc);

                updateNpcEntry(
                    campaignId,
                    finalName,
                    mergedBio,
                    npc.role,
                    npc.status,
                    sessionId,
                    false,
                    npc.alignment_moral,
                    npc.alignment_ethical
                );
                markNpcDirty(campaignId, finalName);
                this.persistBackgroundFactIfNew(campaignId, finalName, sessionId, npcDesc, sessionStartTime, getNpcHistory);
            }
        }
    }

    /**
     * Deterministic fact-preservation: whenever the Analyst supplies new descriptive
     * text about an NPC via npc_dossier_updates, persist it verbatim into npc_history
     * as a zero-weight BACKGROUND row, so it survives future description rewrites
     * (REGENERATE_NPC_NOTES_PROMPT only trusts npc_history as narrative "source of
     * truth" for facts like motive/backstory — the mutable dossier description alone
     * is not enough, it gets overwritten on every bio regeneration). Skips near-duplicates
     * of the NPC's recent history to avoid noisy repeats across sessions.
     */
    private persistBackgroundFactIfNew(
        campaignId: number,
        npcName: string,
        sessionId: string,
        npcDesc: string | undefined,
        sessionStartTime: number,
        getNpcHistory: (campaignId: number, npcName: string) => any[]
    ): void {
        if (!npcDesc || !npcDesc.trim()) return;
        const recent = getNpcHistory(campaignId, npcName).slice(-15);
        if (isNearDuplicateOfExistingHistory(npcDesc, recent)) return;
        addNpcEvent(campaignId, npcName, sessionId, npcDesc, 'BACKGROUND', false, sessionStartTime, 0, 0);
    }

    /**
     * Processes location updates
     */
    private async processLocationUpdates(campaignId: number, sessionId: string, locationUpdates: any[], timestamp: number): Promise<void> {
        if (!locationUpdates?.length) return;

        console.log(`[Atlas] 🗺️ Aggiornamento ${locationUpdates.length} luoghi...`);

        const dedupedLocations = await deduplicateLocationBatch(locationUpdates);
        for (const loc of dedupedLocations) {
            // Allow processing even if description is empty, to catch parenthetical info in names
            if (loc.macro) {
                // Clean Names to remove parentheses (e.g. "Location (Extra)")
                const cleanMacro = cleanEntityName(loc.macro);
                const cleanMicro = cleanEntityName(loc.micro);

                const finalMacro = cleanMacro.name;
                const finalMicro = cleanMicro.name;

                // Append extra info to description if found
                let finalDesc = loc.description ? loc.description.trim() : "";

                if (cleanMacro.extra) {
                    finalDesc = finalDesc ? `${finalDesc} (${cleanMacro.extra})` : cleanMacro.extra;
                }
                if (cleanMicro.extra) {
                    finalDesc = finalDesc ? `${finalDesc} (${cleanMicro.extra})` : cleanMicro.extra;
                }

                // If completely empty after cleaning, skip
                if (!finalDesc && !cleanMacro.extra && !cleanMicro.extra) {
                    if (!finalDesc) continue;
                }

                // 🆕 ID-First Lookup: If Analyst provided an ID, use it directly
                if ((loc as any).id) {
                    const existingById = locationRepository.getAtlasEntryByShortId(campaignId, (loc as any).id);
                    if (existingById) {
                        console.log(`[Atlas] 🎯 ID Match: ${(loc as any).id} → ${existingById.macro_location}/${existingById.micro_location}`);
                        updateAtlasEntry(campaignId, existingById.macro_location, existingById.micro_location, finalDesc, sessionId);
                        addAtlasEvent(campaignId, existingById.macro_location, existingById.micro_location, sessionId, finalDesc, 'UPDATE', false, timestamp);
                        markAtlasDirty(campaignId, existingById.macro_location, existingById.micro_location);
                        continue; // Skip reconciliation
                    }
                }

                // Fallback: Name-based reconciliation
                const reconciled = await reconcileLocationName(campaignId, finalMacro, finalMicro, finalDesc);

                if (reconciled) {
                    console.log(`[Atlas] 🔄 Riconciliato: "${loc.macro}" / "${loc.micro}" → "${reconciled.canonicalMacro}" / "${reconciled.canonicalMicro}"`);
                    updateAtlasEntry(campaignId, reconciled.canonicalMacro, reconciled.canonicalMicro, finalDesc, sessionId);
                    addAtlasEvent(campaignId, reconciled.canonicalMacro, reconciled.canonicalMicro, sessionId, finalDesc, 'RECONCILED', false, timestamp);
                    markAtlasDirty(campaignId, reconciled.canonicalMacro, reconciled.canonicalMicro);
                } else {
                    updateAtlasEntry(campaignId, finalMacro, finalMicro, finalDesc, sessionId);
                    addAtlasEvent(campaignId, finalMacro, finalMicro, sessionId, finalDesc, 'UPDATE', false, timestamp);
                    markAtlasDirty(campaignId, finalMacro, finalMicro);
                }
            }
        }
    }

    /**
     * Processes monster encounters
     */
    private async processMonsters(campaignId: number, sessionId: string, monsters: any[], timestamp: number): Promise<void> {
        if (!monsters?.length) return;

        console.log(`[Bestiario] 👹 Registrazione ${monsters.length} creature...`);

        const dedupedMonsters = await deduplicateMonsterBatch(monsters);
        for (const monster of dedupedMonsters) {
            if (monster.name) {
                // Name Cleaning
                const clean = cleanEntityName(monster.name);
                const monsterName = clean.name;
                // Append extra info to description or notes? Description seems safer.
                const monsterDesc = clean.extra ? `${monster.description || ''} (${clean.extra})`.trim() : (monster.description || '');

                // Signature: (campaignId: number, newName: string, newDescription: string = "")
                const reconciled = await reconcileMonsterName(campaignId, monsterName, monsterDesc);
                const finalName = reconciled ? reconciled.canonicalName : monsterName;
                if (reconciled) console.log(`[Bestiario] 🔄 Riconciliato: "${monster.name}" → "${finalName}"`);

                upsertMonster(
                    campaignId,
                    finalName,
                    monster.status || 'ALIVE',
                    sessionId,
                    {
                        description: monsterDesc,
                        abilities: monster.abilities,
                        weaknesses: monster.weaknesses,
                        resistances: monster.resistances
                    },
                    // Pass original cleaned name as "originalName" to treat it as variant if different
                    // ALSO: If we extracted "extra" info (e.g. "Archer"), treating "Goblin (Archer)" as originalName
                    // automagically works because "Goblin (Archer)" != "Goblin".
                    monster.name,
                    false,
                    timestamp
                );

                // 🆕 History Tracking
                addBestiaryEvent(campaignId, finalName, sessionId, t(getCampaignLocale(campaignId), 'ingest.monsterEncounter', { desc: monsterDesc || t(getCampaignLocale(campaignId), 'ingest.noDescription') }), 'ENCOUNTER', false, timestamp);
            }
        }
    }

    /**
     * Syncs dirty entities to RAG
     */
    async syncDirtyEntities(campaignId: number, validated: any, result: any, channel?: TextChannel, isSilent: boolean = false): Promise<void> {
        const hasValidatedEvents = validated && (validated.npc_events.keep.length > 0 || validated.character_events.keep.length > 0);
        const hasNewMetadata = (result.npc_dossier_updates?.length || 0) > 0 || (result.location_updates?.length || 0) > 0;

        if (!hasValidatedEvents && !hasNewMetadata) return;

        console.log('[Sync] 📊 Controllo NPC, PG e Atlante da sincronizzare...');

        try {
            // Sync NPCs
            const syncedNpcCount = await syncAllDirtyNpcs(campaignId);
            if (syncedNpcCount > 0) {
                console.log(`[Sync] ✅ Sincronizzati ${syncedNpcCount} NPC con RAG.`);
            }

            // Sync Characters
            const charSyncResult = await syncAllDirtyCharacters(campaignId);
            if (charSyncResult.synced > 0) {
                console.log(`[Sync] ✅ Sincronizzati ${charSyncResult.synced} PG: ${charSyncResult.names.join(', ')}`);

                // Notify in channel
                if (channel && charSyncResult.names.length > 0 && !isSilent) {
                    channel.send(`${t(getGuildLocale(channel.guild.id), 'ingest.sheetsUpdated')}\n${charSyncResult.names.map(n => `• ${n}`).join('\n')}`).catch(() => { });
                }
            }

            // Sync Atlas
            if (result.location_updates?.length) {
                const syncedAtlasCount = await syncAllDirtyAtlas(campaignId);
                if (syncedAtlasCount > 0) {
                    console.log(`[Sync] ✅ Sincronizzati ${syncedAtlasCount} luoghi con RAG.`);
                }
            }

            // Sync Bestiary
            const syncedBestiaryCount = await syncAllDirtyBestiary(campaignId);
            if (syncedBestiaryCount > 0) {
                console.log(`[Sync] ✅ Sincronizzati ${syncedBestiaryCount} mostri con RAG.`);
            }

            // Sync Inventory
            const syncedInventoryCount = await syncAllDirtyInventory(campaignId);
            if (syncedInventoryCount > 0) {
                console.log(`[Sync] ✅ Sincronizzati ${syncedInventoryCount} oggetti con RAG.`);
            }

            // Sync Quests
            const syncedQuestCount = await syncAllDirtyQuests(campaignId);
            if (syncedQuestCount > 0) {
                console.log(`[Sync] ✅ Sincronizzati ${syncedQuestCount} quest con RAG.`);
            }

            // 🆕 Sync Factions
            const syncedFactionCount = await syncAllDirtyFactions(campaignId);
            if (syncedFactionCount > 0) {
                console.log(`[Sync] ✅ Sincronizzate ${syncedFactionCount} fazioni con RAG.`);
            }

            // 🆕 Sync Artifacts
            const syncedArtifactCount = await syncAllDirtyArtifacts(campaignId);
            if (syncedArtifactCount > 0) {
                console.log(`[Sync] ✅ Sincronizzati ${syncedArtifactCount} artefatti con RAG.`);
            }
        } catch (e) {
            console.error('[Sync] ⚠️ Errore batch sync:', e);
        }
    }

    /**
     * Process faction updates from the Analyst
     */
    private async processFactionUpdates(campaignId: number, sessionId: string, factionUpdates: any[], timestamp: number): Promise<void> {
        for (const update of factionUpdates) {
            if (!update.name) continue;

            const cleanName = cleanEntityName(update.name);
            const factionName = cleanName.name;

            // 🆕 ID-First Lookup: If Analyst provided an ID, use it directly
            let faction = null;
            if (update.id) {
                faction = factionRepository.getFactionByShortId(campaignId, update.id);
                if (faction) {
                    console.log(`[Faction] 🎯 ID Match: ${update.id} → ${faction.name}`);
                    // Update using matched faction
                    const shouldUpdateDesc = update.description && !faction.is_manual;
                    const shouldUpdateAlignment = update.alignment_moral || update.alignment_ethical;

                    if (shouldUpdateDesc || shouldUpdateAlignment) {
                        factionRepository.updateFaction(campaignId, faction.name, {
                            ...(shouldUpdateDesc && { description: update.description }),
                            ...(update.alignment_moral && { alignment_moral: update.alignment_moral }),
                            ...(update.alignment_ethical && { alignment_ethical: update.alignment_ethical })
                        }, false);
                    }
                }
            }

            // Fallback: Name-based lookup
            if (!faction) {
                faction = factionRepository.getFaction(campaignId, factionName);
            }

            if (!faction) {
                // Create new faction if it doesn't exist
                faction = factionRepository.createFaction(campaignId, factionName, {
                    description: update.description || cleanName.extra,
                    type: update.type || 'GENERIC',
                    sessionId,
                    isManual: false
                });
                console.log(`[Faction] ➕ Nuova fazione creata: ${factionName}`);

                // Set alignment if provided
                if (faction && (update.alignment_moral || update.alignment_ethical)) {
                    factionRepository.updateFaction(campaignId, factionName, {
                        alignment_moral: update.alignment_moral,
                        alignment_ethical: update.alignment_ethical
                    }, false);
                }
            } else if (!update.id) {
                // Update existing faction (only if not already updated via ID-first) - but protect manual descriptions!
                const shouldUpdateDesc = update.description && !faction.is_manual;
                const shouldUpdateAlignment = update.alignment_moral || update.alignment_ethical;

                if (shouldUpdateDesc || shouldUpdateAlignment) {
                    factionRepository.updateFaction(campaignId, factionName, {
                        ...(shouldUpdateDesc && { description: update.description }),
                        ...(update.alignment_moral && { alignment_moral: update.alignment_moral }),
                        ...(update.alignment_ethical && { alignment_ethical: update.alignment_ethical })
                    }, false);

                    if (faction.is_manual && update.description) {
                        console.log(`[Faction] 🔒 Descrizione manuale protetta per: ${factionName}`);
                    } else if (shouldUpdateDesc) {
                        console.log(`[Faction] 🔄 Aggiornata: ${factionName}`);
                    }
                }
            }

            // Always log the faction processing
            const safeDesc = update.description || faction?.description || 'Nessuna descrizione';
            let safeRep = update.reputation || 'NEUTRAL';

            if (!update.reputation && faction) {
                safeRep = factionRepository.getFactionReputation(campaignId, faction.id);
            }

            console.log(`[Faction] ➕ ${factionName}: ${safeDesc.substring(0, 50)}${safeDesc.length > 50 ? '...' : ''} (Rep: ${safeRep})`);

            if (update.reputation_change && faction) {
                const changeValue = update.reputation_change.value || 0;

                // Idempotency: clear previous REPUTATION_CHANGE events for this session+faction
                factionRepository.clearSessionFactionEvents(campaignId, factionName, sessionId);

                // addFactionEvent now handles reputation_score accumulation and label derivation
                factionRepository.addFactionEvent(
                    campaignId,
                    factionName,
                    sessionId,
                    t(getCampaignLocale(campaignId), 'ingest.reputationChange', { value: changeValue, reason: update.reputation_change.reason || t(getCampaignLocale(campaignId), 'ingest.noReason') }),
                    'REPUTATION_CHANGE',
                    false,
                    changeValue,
                    0,
                    0,
                    timestamp
                );
                console.log(`[Faction] 📊 Reputazione ${factionName}: CHANGE ${changeValue}`);
            } else if (update.reputation && faction) {
                const validReps = ['HOSTILE', 'DISTRUSTFUL', 'COLD', 'NEUTRAL', 'CORDIAL', 'FRIENDLY', 'ALLIED'];
                const repMap: Record<string, string> = {
                    'OSTILE': 'HOSTILE', 'DIFFIDENTE': 'DISTRUSTFUL', 'FREDDO': 'COLD',
                    'NEUTRALE': 'NEUTRAL', 'CORDIALE': 'CORDIAL', 'AMICHEVOLE': 'FRIENDLY', 'ALLEATO': 'ALLIED'
                };
                const upperRep = repMap[update.reputation.toUpperCase()] || update.reputation.toUpperCase();
                if (validReps.includes(upperRep)) {
                    factionRepository.setFactionReputation(campaignId, faction.id, upperRep as any);
                    factionRepository.addFactionEvent(
                        campaignId,
                        factionName,
                        sessionId,
                        t(getCampaignLocale(campaignId), 'ingest.reputationSet', { rep: eventTypeLabel(getCampaignLocale(campaignId), upperRep) }),
                        'REPUTATION_CHANGE',
                        false,
                        0,
                        0,
                        0,
                        timestamp
                    );
                    console.log(`[Faction] 📊 Reputazione ${factionName}: SET ${upperRep}`);
                }
            }
        }
    }

    /**
     * Process faction affiliations from the Analyst
     */
    private async processFactionAffiliations(campaignId: number, sessionId: string, affiliations: any[], timestamp: number): Promise<void> {

        for (const affiliation of affiliations) {
            if (!affiliation.entity_name || !affiliation.faction_name) continue;

            const cleanFactionName = cleanEntityName(affiliation.faction_name);
            const factionName = cleanFactionName.name;

            // Find the faction: ID-first, then name fallback
            let faction = null;
            if (affiliation.faction_id) {
                faction = factionRepository.getFactionByShortId(campaignId, affiliation.faction_id);
                if (faction) console.log(`[Faction Affil] 🎯 Faction ID Match: ${affiliation.faction_id} → ${faction.name}`);
            }
            if (!faction) {
                faction = factionRepository.getFaction(campaignId, factionName);
            }
            if (!faction) {
                // Create faction if it doesn't exist
                faction = factionRepository.createFaction(campaignId, factionName, {
                    type: 'GENERIC',
                    sessionId,
                    isManual: false
                });
            }

            if (!faction) continue;

            // Determine entity type and find it
            const entityType = affiliation.entity_type?.toLowerCase() || 'npc';
            const cleanEntityName_ = cleanEntityName(affiliation.entity_name);
            const entityName = cleanEntityName_.name;

            if (entityType === 'npc') {
                // ID-first lookup for NPC
                let npc = null;
                if (affiliation.entity_id) {
                    npc = npcRepository.getNpcByShortId(campaignId, affiliation.entity_id);
                    if (npc) console.log(`[Faction Affil] 🎯 NPC ID Match: ${affiliation.entity_id} → ${npc.name}`);
                }

                if (!npc) {
                    // Fallback: name-based reconciliation
                    const reconciled = await reconcileNpcName(campaignId, entityName);
                    if (reconciled?.isPlayerCharacter) {
                        console.log(`[Faction Affil] 🎮 Skip affiliazione NPC per PG: "${entityName}"`);
                        continue;
                    }
                    const targetName = reconciled ? reconciled.canonicalName : entityName;

                    npc = getNpcEntry(campaignId, targetName);
                    if (!npc) {
                        npc = getNpcByAlias(campaignId, entityName);
                    }
                }

                if (npc) {
                    const action = affiliation.action?.toUpperCase() || 'JOIN';
                    const role = affiliation.role?.toUpperCase() || 'MEMBER';
                    const validNpcRoles = ['LEADER', 'MEMBER', 'ALLY', 'ENEMY', 'PRISONER'];

                    if (action === 'LEAVE') {
                        factionRepository.removeAffiliation(faction.id, 'npc', npc.id);
                        factionRepository.addFactionEvent(
                            campaignId,
                            faction.name,
                            sessionId,
                            t(getCampaignLocale(campaignId), 'ingest.npcLeftFaction', { name: npc.name }),
                            'MEMBER_LEAVE',
                            false
                        );
                        console.log(`[Faction] 👋 ${npc.name} ← ${faction.name} (LEAVE)`);
                    } else if (validNpcRoles.includes(role)) {
                        factionRepository.addAffiliation(faction.id, 'npc', npc.id, { role: role as any });
                        factionRepository.addFactionEvent(
                            campaignId,
                            faction.name,
                            sessionId,
                            t(getCampaignLocale(campaignId), 'ingest.npcJoinedFaction', { name: npc.name, role: eventTypeLabel(getCampaignLocale(campaignId), role) }),
                            'MEMBER_JOIN',
                            false
                        );
                        console.log(`[Faction] 🤝 ${npc.name} → ${faction.name} (${role})`);
                    }
                }
            } else if (entityType === 'location') {

                // ID-first lookup for location
                let loc = null;
                if (affiliation.entity_id) {
                    loc = locationRepository.getAtlasEntryByShortId(campaignId, affiliation.entity_id);
                    if (loc) console.log(`[Faction Affil] 🎯 Location ID Match: ${affiliation.entity_id} → ${loc.macro_location}/${loc.micro_location}`);
                }

                if (!loc) {
                    // Fallback: name-based lookup
                    if (entityName.includes('|')) {
                        const [macro, micro] = entityName.split('|').map(s => s.trim());
                        loc = getAtlasEntryFull(campaignId, macro, micro);
                    } else {
                        const allLocs = locationRepository.listAllAtlasEntries(campaignId);
                        const match = allLocs.find((l: any) => l.micro_location.toLowerCase() === entityName.toLowerCase());
                        if (match) loc = getAtlasEntryFull(campaignId, match.macro_location, match.micro_location);
                    }
                }

                if (loc) {
                    const action = affiliation.action?.toUpperCase() || 'JOIN';
                    const role = affiliation.role?.toUpperCase() || 'CONTROLLED';
                    const validLocationRoles = ['CONTROLLED', 'HQ', 'PRESENCE', 'HOSTILE'];

                    if (action === 'LEAVE') {
                        factionRepository.removeAffiliation(faction.id, 'location', loc.id);
                        factionRepository.addFactionEvent(
                            campaignId,
                            faction.name,
                            sessionId,
                            t(getCampaignLocale(campaignId), 'ingest.locationLeftFaction', { name: entityName }),
                            'MEMBER_LEAVE',
                            false
                        );
                        console.log(`[Faction] 👋📍 ${entityName} ← ${faction.name} (LEAVE)`);
                    } else if (validLocationRoles.includes(role)) {
                        factionRepository.addAffiliation(faction.id, 'location', loc.id, { role: role as any });
                        factionRepository.addFactionEvent(
                            campaignId,
                            faction.name,
                            sessionId,
                            t(getCampaignLocale(campaignId), 'ingest.locationJoinedFaction', { name: entityName, role: eventTypeLabel(getCampaignLocale(campaignId), role) }),
                            'GENERIC',
                            false
                        );
                        console.log(`[Faction] 📍 ${entityName} → ${faction.name} (${role})`);
                    }
                }
            }
        }
    }

    // Process artifacts from the Analyst (magical/legendary items)
    private async processArtifacts(campaignId: number, sessionId: string, artifacts: any[], timestamp: number): Promise<void> {
        console.log(`[Artifact] 🔍 DEBUG: processArtifacts chiamato con ${artifacts?.length || 0} artefatti`);
        if (!artifacts?.length) {
            console.log(`[Artifact] ⚠️ DEBUG: Return early - artifacts vuoti`);
            return;
        }

        for (const artifact of artifacts) {
            if (!artifact.name) continue;

            // Clean name (remove parentheses if present)
            const clean = cleanEntityName(artifact.name);
            const artifactName = clean.name;

            // Resolve faction ID if faction_name OR faction_id (ShortID) is provided
            let factionId: number | undefined;

            // 1. Try Name
            if (artifact.faction_name) {
                const faction = getFaction(campaignId, artifact.faction_name);
                if (faction) {
                    factionId = faction.id;
                }
            }

            // 2. Try ShortID (if not found by name)
            if (!factionId && artifact.faction_id) {
                const faction = factionRepository.getFactionByShortId(campaignId, artifact.faction_id.toString());
                if (faction) {
                    factionId = faction.id;
                    console.log(`[Artifact] 🎯 Faction ID Match: ${artifact.faction_id} → ${faction.name}`);
                }
            }

            // 🆕 ID-First Lookup: If Analyst provided an ID, use it directly
            let existing = null;
            if (artifact.id) {
                existing = getArtifactByShortId(campaignId, artifact.id);
                if (existing) {
                    console.log(`[Artifact] 🎯 ID Match: ${artifact.id} → ${existing.name}`);
                }
            }

            // Fallback: Name-based lookup
            if (!existing) {
                existing = getArtifactByName(campaignId, artifactName);
            }
            const isNew = !existing;

            // Prepare details
            // Sanitize function to filter out "UNKNOWN" or empty values
            const sanitize = (val: string | null | undefined) => {
                if (!val) return undefined;
                const v = val.trim();
                if (v === '' || v.toUpperCase() === 'UNKNOWN' || v.toUpperCase() === 'SCONOSCIUTO' || v.toUpperCase() === 'NESSUNO') return undefined;
                return v;
            };

            const cleanOwnerName = sanitize(artifact.owner_name);
            const cleanMacro = sanitize(artifact.location_macro);
            const cleanMicro = sanitize(artifact.location_micro);

            // Determine owner_type
            // If explicit type is provided, use it.
            // If owner_name is UNKNOWN/undefined, strict check:
            //   - If it's NEW, default to NONE (or whatever type was provided if any)
            //   - If it's EXISTING, treat type as undefined (don't overwrite) UNLESS explicitly provided different from current? 
            //     Actually, safer to just use the provided type unless it's strictly defaulted strings.
            //     But if name is UNKNOWN, we probably shouldn't change type to NPC if it was something else, 
            //     unless we really trust the analyst's type classification without a name. 
            //     Let's rely on standard COALESCE behavior but be careful with 'NONE' defaults.

            let ownerType = artifact.owner_type;
            if (!ownerType || ownerType === 'NONE') {
                // If input is NONE or missing
                if (isNew) ownerType = 'NONE';
                else ownerType = undefined; // Don't overwrite existing with NONE unless explicit? 
                // Actually if analyst says NONE explicitly, maybe it WAS dropped. 
                // But earlier code defaulted `|| 'NONE'`. 
                // If analyst returns undefined, we want undefined.
                // If analyst returns 'NONE', we want 'NONE'.
                if (artifact.owner_type === 'NONE') ownerType = 'NONE';
            }

            // Special case: If name is unknown, and type is NPC, but we already have an owner,
            // we might want to skip these updates to prevent "NPC Unknown" overwrites.
            if (!cleanOwnerName && ownerType === 'NPC' && !isNew) {
                // If we don't have a name, but type is NPC, and it's an update...
                // Only apply if we really want to assert "It is held by SOMEONE".
                // Allow it for now, but since cleanOwnerName is undefined, it won't overwrite the name.
                // It will just change type to NPC. 
            }

            const details = {
                description: artifact.description,
                effects: artifact.effects,
                is_cursed: artifact.is_cursed || false,
                curse_description: artifact.curse_description,
                owner_type: ownerType,
                owner_name: cleanOwnerName,
                location_macro: cleanMacro,
                location_micro: cleanMicro,
                faction_id: factionId
            };

            // Upsert the artifact
            // Map Italian status to English if needed (AI may still return Italian)
            const artifactStatusMap: Record<string, string> = {
                'FUNZIONANTE': 'FUNCTIONAL', 'DISTRUTTO': 'DESTROYED', 'PERDUTO': 'LOST',
                'SIGILLATO': 'SEALED', 'DORMIENTE': 'DORMANT'
            };
            const rawStatus = artifact.status ? artifact.status.toUpperCase() : 'FUNCTIONAL';
            const mappedStatus = artifactStatusMap[rawStatus] || rawStatus;
            console.log(`[Artifact] 🔍 DEBUG: Upserting artifact "${artifactName}" con status "${mappedStatus}"`);
            try {
                upsertArtifact(
                    campaignId,
                    artifactName,
                    mappedStatus as any,
                    sessionId,
                    details,
                    false, // Not manual
                    timestamp
                );
                console.log(`[Artifact] ✅ DEBUG: upsertArtifact completato per "${artifactName}"`);
            } catch (err: any) {
                console.error(`[Artifact] ❌ DEBUG: Errore upsertArtifact per "${artifactName}":`, err.message);
            }

            // Log appropriate event
            const eventType = isNew ? 'DISCOVERY' : 'OBSERVATION';
            const eventDescription = isNew
                ? t(getCampaignLocale(campaignId), 'ingest.artifactDiscovered', { desc: artifact.description || t(getCampaignLocale(campaignId), 'ingest.noDescription') })
                : t(getCampaignLocale(campaignId), 'ingest.artifactObserved', { desc: artifact.description || t(getCampaignLocale(campaignId), 'ingest.artifactInfoUpdate') });

            addArtifactEvent(
                campaignId,
                artifactName,
                sessionId,
                eventDescription,
                eventType,
                false,
                timestamp
            );

            // 🆕 Syncs the artifact with the inventory according to its owner
            const previousOwnerType = existing?.owner_type;
            const newOwnerType = ownerType;

            // If the artifact PASSES to the party (PC) → add it to the inventory
            if (newOwnerType === 'PC') {
                const existingInInventory = inventoryRepository.getInventoryItemByName(campaignId, artifactName);

                if (!existingInInventory) {
                    inventoryRepository.addLoot(
                        campaignId,
                        artifactName,
                        1,
                        sessionId,
                        artifact.description || undefined,
                        false,
                        timestamp
                    );
                    console.log(`[Artifact→Inventory] 🔮 Artefatto "${artifactName}" aggiunto all'inventario del party`);
                }
            }
            // If the artifact LEAVES the party (was a PC, no longer) → drop it from the inventory
            else if (previousOwnerType === 'PC' && newOwnerType && newOwnerType !== 'PC') {
                const existingInInventory = inventoryRepository.getInventoryItemByName(campaignId, artifactName);

                if (existingInInventory) {
                    inventoryRepository.removeLoot(campaignId, artifactName, 999999); // Remove everything
                    console.log(`[Artifact→Inventory] 💨 Artefatto "${artifactName}" rimosso dall'inventario (nuovo proprietario: ${newOwnerType})`);
                }
            }

            console.log(`[Artifact] ➕ ${artifactName}: ${artifact.description ? artifact.description.substring(0, 50) + (artifact.description.length > 50 ? '...' : '') : 'Nessuna descrizione'} (Status: ${mappedStatus})`);

            console.log(`[Artifact] ✨ ${isNew ? 'Nuovo' : 'Aggiornato'}: ${artifactName}`);
        }
    }
}
