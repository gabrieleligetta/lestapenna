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
    getNpcByAlias
} from '../../db';
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
        const { getSessionStartTime } = await import('../../db');
        const sessionStartTime = getSessionStartTime(sessionId) || Date.now();

        if (result.character_growth?.length) batchInput.character_events = result.character_growth;
        if (result.npc_events?.length) batchInput.npc_events = result.npc_events;
        if (result.world_events?.length) batchInput.world_events = result.world_events;
        if (result.artifact_events?.length) batchInput.artifact_events = result.artifact_events;
        if (result.loot?.length) batchInput.loot = result.loot;
        if (result.loot_removed?.length) batchInput.loot_removed = result.loot_removed;
        if (result.quests?.length) batchInput.quests = result.quests;

        // 📍 PHASE: VALIDATING
        sessionPhaseManager.setPhase(sessionId, 'VALIDATING');

        // Execute batch validation
        let validated: any = null;
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

        // 🆕 Process Faction Updates (MOVED FIRST to ensure IDs exist)
        if (result.faction_updates?.length) {
            console.log(`[Ingestion] ⚔️ Salvataggio ${result.faction_updates.length} aggiornamenti fazioni...`);
            await this.processFactionUpdates(campaignId, sessionId, result.faction_updates, sessionStartTime);
        }



        // 🆕 Process Party Alignment
        if (result.party_alignment_change) {
            const { moral, ethical, reason } = result.party_alignment_change;
            if (moral || ethical) {
                console.log(`[Ingestion] ⚖️ Allineamento Party: ${moral || '-'} / ${ethical || '-'} (${reason})`);
                const { campaignRepository, addWorldEvent, factionRepository } = await import('../../db');
                campaignRepository.updatePartyAlignment(campaignId, moral, ethical);

                // 🆕 Sync with Factions table
                const partyFaction = factionRepository.getPartyFaction(campaignId);
                if (partyFaction) {
                    factionRepository.updateFaction(campaignId, partyFaction.name, {
                        alignment_moral: moral,
                        alignment_ethical: ethical
                    }, false);
                    console.log(`[Ingestion] 🎭 Fazione Party allineata: ${partyFaction.name}`);
                }

                addWorldEvent(
                    campaignId,
                    sessionId,
                    `L'allineamento del gruppo è cambiato: ${moral ? `Morale: ${moral}` : ''} ${ethical ? `Etico: ${ethical}` : ''}. Motivo: ${reason}`,
                    'POLITICS', // Usa un tipo esistente
                    undefined,
                    false,
                    sessionStartTime
                );
            }
        }

        // Process NPC dossier updates (metadata)
        if (result.npc_dossier_updates?.length) {
            await this.processNpcDossierUpdates(campaignId, sessionId, result.npc_dossier_updates);
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

            // 🆕 Update last_seen_location for each NPC
            const { campaignRepository, npcRepository } = await import('../../db');
            const campaign = campaignRepository.getCampaignById(campaignId);
            if (campaign?.current_macro_location || campaign?.current_micro_location) {
                const location = [campaign.current_macro_location, campaign.current_micro_location]
                    .filter(Boolean).join(' - ');
                for (const npcName of result.present_npcs) {
                    npcRepository.updateNpcLastSeenLocation(campaignId, npcName, location);
                }
            }
        }

        // 🆕 Process Character Updates (Alignment)
        if (result.character_updates?.length) {
            console.log(`[Ingestion] 👤 Salvataggio ${result.character_updates.length} aggiornamenti PG...`);
            await this.processCharacterUpdates(campaignId, sessionId, result.character_updates);
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
            for (const travel of result.travel_sequence) {
                updateLocation(campaignId, travel.macro, travel.micro, sessionId, travel.reason, sessionStartTime);
            }
        }

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
            const { npcRepository } = await import('../../db');
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
            const safeDesc = clean.extra ? `${clean.name} (${clean.extra})` : clean.name || "Evento mondiale registrato.";

            console.log(`[World] ➕ ${safeDesc}`);
            // Signature: (campaignId: number, sessionId: string | null, description: string, type: string, year?: number, manual, timestamp)
            addWorldEvent(campaignId, sessionId, safeDesc, evt.type || 'EVENT', undefined, false, timestamp);
            // Signature: (campaignId: number, sessionId: string, event: string, type: string, timestamp)
            await ingestWorldEvent(campaignId, sessionId, safeDesc, evt.type || 'EVENT', timestamp);
        }

        // 🆕 Artifact events
        if (validated.artifact_events?.keep?.length) {
            const { addArtifactEvent, markArtifactDirty, getArtifactByShortId } = await import('../../db');
            for (const evt of validated.artifact_events.keep) {
                const safeDesc = evt.event || "Evento artefatto registrato.";
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

                addLoot(campaignId, finalName, item.quantity || 1, sessionId, itemDesc, false, timestamp);

                // 🆕 History Tracking
                addInventoryEvent(campaignId, finalName, sessionId, `Acquisito: ${itemDesc || 'Nessuna descrizione'}`, 'LOOT', false, timestamp);

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
                addInventoryEvent(campaignId, finalName, sessionId, `Rimosso/Usato: ${item.description || 'Nessuna descrizione'}`, 'USE', false, timestamp);

                // Also ingest in RAG to track WHY it was removed
                await ingestLootEvent(campaignId, sessionId, {
                    ...item,
                    name: `[RIMOSSO/USATO] ${finalName}`
                }, timestamp);
            }
        }

        // Quests
        for (const quest of validated.quests.keep) {
            // Handle both string and object formats for backward compatibility
            const rawTitle = typeof quest === 'string' ? quest : quest.title;
            const rawDesc = typeof quest === 'string' ? '' : quest.description;
            const status = typeof quest === 'string' ? 'OPEN' : (quest.status || 'OPEN');

            // Clean Title
            const clean = cleanEntityName(rawTitle);
            const title = clean.name;
            // Prepend extra info to description if found
            const description = clean.extra
                ? (rawDesc ? `[${clean.extra}] ${rawDesc}` : `[${clean.extra}]`)
                : rawDesc;

            console.log(`[Quest] ➕ ${title} (${status})`);

            // Signature: (campaignId: number, title: string, sessionId?: string, description?: string, status?: string, type?: string, manual, timestamp)
            addQuest(campaignId, title, sessionId, description, status, quest.type || 'MAJOR', false, timestamp);

            // 🆕 History Tracking
            addQuestEvent(campaignId, title, sessionId, description || `Quest aggiornata: ${status}`, status === 'OPEN' ? 'PROGRESS' : status, false, timestamp);
        }
    }

    /**
     * Processes NPC dossier updates
     */
    private async processNpcDossierUpdates(campaignId: number, sessionId: string, npcUpdates: any[]): Promise<void> {
        console.log(`[NPC Dossier] 📋 Aggiornamento ${npcUpdates.length} schede NPC...`);

        const { npcRepository } = await import('../../db');
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
                        continue; // Skip reconciliation
                    }
                }

                // Fallback: Name-based reconciliation
                const reconciled = await reconcileNpcName(campaignId, npcName, npcDesc);
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
            }
        }
    }

    /**
     * Processes location updates
     */
    private async processLocationUpdates(campaignId: number, sessionId: string, locationUpdates: any[], timestamp: number): Promise<void> {
        if (!locationUpdates?.length) return;

        console.log(`[Atlas] 🗺️ Aggiornamento ${locationUpdates.length} luoghi...`);

        const { locationRepository } = await import('../../db');
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
                    monster.count,
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
                addBestiaryEvent(campaignId, finalName, sessionId, `Incontro: ${monsterDesc || 'Nessuna descrizione'}`, 'ENCOUNTER', false, timestamp);
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
                    channel.send(`📜 **Schede Aggiornate Automaticamente**\n${charSyncResult.names.map(n => `• ${n}`).join('\n')}`).catch(() => { });
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
            let safeRep = update.reputation || 'NEUTRALE';

            if (!update.reputation && faction) {
                safeRep = factionRepository.getFactionReputation(campaignId, faction.id);
            }

            console.log(`[Faction] ➕ ${factionName}: ${safeDesc.substring(0, 50)}${safeDesc.length > 50 ? '...' : ''} (Rep: ${safeRep})`);

            if (update.reputation_change && faction) {
                const changeValue = update.reputation_change.value || 0;

                // Adjust reputation by iterating steps if needed, OR just set it if we have a target?
                // The new system uses "value" (numeric change?). 
                // Wait, Prompt says "value": "integer from -N to +N".
                // `adjustReputation` method in repo uses 'UP'/'DOWN' steps.
                // I might need to map value to steps or update `factionRepository` to handle numeric shifts.
                // For now, let's just log it and add the event with the value.
                // TODO: Update factionRepository to handle numeric reputation shift if desired.
                // For now, we rely on the event history.

                // If value is > 0, we can try to "UP", if < 0 "DOWN" (rough approximation for existing logic)
                // But the `reputation_change_value` column is what matters for the alignment system.

                if (changeValue !== 0) {
                    // Try to apply legacy reputation step limit
                    if (changeValue > 0) factionRepository.adjustReputation(campaignId, faction.id, 'UP');
                    if (changeValue < 0) factionRepository.adjustReputation(campaignId, faction.id, 'DOWN');
                }

                factionRepository.addFactionEvent(
                    campaignId,
                    factionName,
                    sessionId,
                    `Cambiamento reputazione (${changeValue}): ${update.reputation_change.reason || 'Nessun motivo'}`,
                    'REPUTATION_CHANGE',
                    false,
                    changeValue,
                    update.reputation_change.moral_impact || 0,
                    update.reputation_change.ethical_impact || 0,
                    timestamp
                );
                console.log(`[Faction] 📊 Reputazione ${factionName}: CHANGE ${changeValue}`);
            } else if (update.reputation && faction) {
                const validReps = ['OSTILE', 'DIFFIDENTE', 'FREDDO', 'NEUTRALE', 'CORDIALE', 'AMICHEVOLE', 'ALLEATO'];
                const upperRep = update.reputation.toUpperCase();
                if (validReps.includes(upperRep)) {
                    factionRepository.setFactionReputation(campaignId, faction.id, upperRep as any);
                    factionRepository.addFactionEvent(
                        campaignId,
                        factionName,
                        sessionId,
                        `Reputazione impostata a ${upperRep}`,
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
     * Process character updates (alignment)
     */
    private async processCharacterUpdates(campaignId: number, sessionId: string, updates: any[]): Promise<void> {
        const { characterRepository, addCharacterEvent } = await import('../../db');

        for (const update of updates) {
            if (!update.name) continue;

            const moral = update.alignment_moral;
            const ethical = update.alignment_ethical;

            if (moral || ethical) {
                characterRepository.updateCharacterAlignment(campaignId, update.name, moral, ethical);

                // Add event to history
                addCharacterEvent(
                    campaignId,
                    update.name,
                    sessionId,
                    `Allineamento aggiornato: ${moral ? `Morale: ${moral}` : ''} ${ethical ? `Etico: ${ethical}` : ''}`,
                    'GOAL_CHANGE',
                    false
                );
            }
        }
    }

    /**
     * Process faction affiliations from the Analyst
     */
    private async processFactionAffiliations(campaignId: number, sessionId: string, affiliations: any[], timestamp: number): Promise<void> {
        const { getNpcEntry } = await import('../../db');

        for (const affiliation of affiliations) {
            if (!affiliation.entity_name || !affiliation.faction_name) continue;

            const cleanFactionName = cleanEntityName(affiliation.faction_name);
            const factionName = cleanFactionName.name;

            // Find the faction
            let faction = factionRepository.getFaction(campaignId, factionName);
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
                // Try to resolve NPC name robustly
                const reconciled = await reconcileNpcName(campaignId, entityName);
                const targetName = reconciled ? reconciled.canonicalName : entityName;

                let npc = getNpcEntry(campaignId, targetName);
                if (!npc) {
                    npc = getNpcByAlias(campaignId, entityName);
                }

                if (npc) {
                    const role = affiliation.role?.toUpperCase() || 'MEMBER';
                    const validRoles = ['LEADER', 'MEMBER', 'ALLY', 'ENEMY', 'CONTROLLED', 'HQ', 'PRESENCE', 'HOSTILE', 'PRISONER'];
                    if (validRoles.includes(role)) {
                        factionRepository.addAffiliation(faction.id, 'npc', npc.id, { role: role as any });
                        factionRepository.addFactionEvent(
                            campaignId,
                            factionName,
                            sessionId,
                            `NPC "${entityName}" affiliato come ${role}`,
                            'MEMBER_JOIN',
                            false
                        );
                        console.log(`[Faction] 🤝 ${entityName} → ${factionName} (${role})`);
                    }
                }
            } else if (entityType === 'location') {
                const { getAtlasEntryFull } = await import('../../db');
                // Locations usually have "Macro | Micro" or just "Micro" in entity_name
                let loc = null;
                if (entityName.includes('|')) {
                    const [macro, micro] = entityName.split('|').map(s => s.trim());
                    loc = getAtlasEntryFull(campaignId, macro, micro);
                } else {
                    const allLocs = locationRepository.listAllAtlasEntries(campaignId);
                    const match = allLocs.find((l: any) => l.micro_location.toLowerCase() === entityName.toLowerCase());
                    if (match) loc = getAtlasEntryFull(campaignId, match.macro_location, match.micro_location);
                }

                if (loc) {
                    const role = affiliation.role?.toUpperCase() || 'CONTROLLED';
                    const validRoles = ['LEADER', 'MEMBER', 'ALLY', 'ENEMY', 'CONTROLLED', 'HQ', 'PRESENCE', 'HOSTILE', 'PRISONER'];
                    if (validRoles.includes(role)) {
                        factionRepository.addAffiliation(faction.id, 'location', loc.id, { role: role as any });
                        factionRepository.addFactionEvent(
                            campaignId,
                            factionName,
                            sessionId,
                            `Luogo "${entityName}" affiliato come ${role}`,
                            'GENERIC', // Or a more specific event if available
                            false
                        );
                        console.log(`[Faction] 📍 ${entityName} → ${factionName} (${role})`);
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

        const {
            upsertArtifact,
            addArtifactEvent,
            getArtifactByName,
            getArtifactByShortId,
            getFaction
        } = await import('../../db');

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
                // Lazy load if needed or assume it's available via repository imports
                // We need to import factionRepository but getFaction covers names.
                // Let's rely on the module import standard logic or specific function if available.
                // Note: 'getFaction' is imported from '../../db'. We check if getFactionByShortId is available or if we need to call repo.
                // Looking at imports at top of file... factionRepository IS imported in 'processBatchEvents' via 'await import'.
                // Here we are in 'processArtifacts'.
                const { factionRepository } = await import('../../db/repositories/FactionRepository');
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
            console.log(`[Artifact] 🔍 DEBUG: Upserting artifact "${artifactName}" con status "${artifact.status || 'FUNZIONANTE'}"`);
            try {
                upsertArtifact(
                    campaignId,
                    artifactName,
                    artifact.status || 'FUNZIONANTE',
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
                ? `Scoperto: ${artifact.description || 'Nessuna descrizione'}`
                : `Osservato: ${artifact.description || 'Aggiornamento informazioni'}`;

            addArtifactEvent(
                campaignId,
                artifactName,
                sessionId,
                eventDescription,
                eventType,
                false,
                timestamp
            );

            // 🆕 Sincronizza artefatto con inventario in base al proprietario
            const { inventoryRepository } = await import('../../db/repositories/InventoryRepository');
            const previousOwnerType = existing?.owner_type;
            const newOwnerType = ownerType;

            // Se l'artefatto PASSA al party (PC) → aggiungilo all'inventario
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
            // Se l'artefatto LASCIA il party (era PC, ora non più) → rimuovilo dall'inventario
            else if (previousOwnerType === 'PC' && newOwnerType && newOwnerType !== 'PC') {
                const existingInInventory = inventoryRepository.getInventoryItemByName(campaignId, artifactName);

                if (existingInInventory) {
                    inventoryRepository.removeLoot(campaignId, artifactName, 999999); // Rimuovi tutto
                    console.log(`[Artifact→Inventory] 💨 Artefatto "${artifactName}" rimosso dall'inventario (nuovo proprietario: ${newOwnerType})`);
                }
            }

            console.log(`[Artifact] ➕ ${artifactName}: ${artifact.description ? artifact.description.substring(0, 50) + (artifact.description.length > 50 ? '...' : '') : 'Nessuna descrizione'} (Status: ${artifact.status || 'FUNZIONANTE'})`);

            console.log(`[Artifact] ✨ ${isNew ? 'Nuovo' : 'Aggiornato'}: ${artifactName}`);
        }
    }
}

