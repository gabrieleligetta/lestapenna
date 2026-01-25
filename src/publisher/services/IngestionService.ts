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
    addBestiaryEvent
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
        channel?: TextChannel
    ): Promise<void> {
        // Prepare batch input
        const batchInput: any = {};

        if (result.character_growth?.length) batchInput.character_events = result.character_growth;
        if (result.npc_events?.length) batchInput.npc_events = result.npc_events;
        if (result.world_events?.length) batchInput.world_events = result.world_events;
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
                (batchInput.loot?.length || 0) +
                (batchInput.quests?.length || 0);

            const totalKept =
                (validated.npc_events.keep.length) +
                (validated.character_events.keep.length) +
                (validated.world_events.keep.length) +
                (validated.loot.keep.length) +
                (validated.loot_removed.keep.length) +
                (validated.quests.keep.length);

            const totalSkipped = totalInput - totalKept;
            const filterRate = totalInput > 0 ? Math.round((totalSkipped / totalInput) * 100) : 0;

            console.log(`[Validator] ✅ Validazione completata:`);
            console.log(`  - Accettati: ${totalKept}/${totalInput}`);
            console.log(`  - Filtrati: ${totalSkipped} (${filterRate}%)`);
        }

        // Process validated events
        if (validated) {
            await this.processValidatedEvents(campaignId, sessionId, validated);
        }

        // Process NPC dossier updates (metadata)
        if (result.npc_dossier_updates?.length) {
            await this.processNpcDossierUpdates(campaignId, sessionId, result.npc_dossier_updates);
        }

        // Process location updates (metadata)
        if (result.location_updates?.length) {
            await this.processLocationUpdates(campaignId, sessionId, result.location_updates);
        }

        // Process monsters
        await this.processMonsters(campaignId, sessionId, result.monsters);

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
                await ingestGenericEvent(campaignId, sessionId, `[LOG AZIONE] ${entry}`, [], 'SESSION_LOG');
            }
        }

        // 🆕 Process Travel Sequence
        if (result.travel_sequence?.length) {
            console.log(`[Ingestion] 🗺️ Salvataggio ${result.travel_sequence.length} spostamenti...`);
            for (const travel of result.travel_sequence) {
                updateLocation(campaignId, travel.macro, travel.micro, sessionId, travel.reason);
            }
        }

        // 📍 PHASE: SYNCING
        sessionPhaseManager.setPhase(sessionId, 'SYNCING');

        // Sync dirty entities to RAG
        await this.syncDirtyEntities(campaignId, validated, result, channel);
    }

    /**
     * Processes validated events
     */
    private async processValidatedEvents(campaignId: number, sessionId: string, validated: any): Promise<void> {
        // Character events
        for (const evt of validated.character_events.keep) {
            const safeDesc = evt.event || "Evento significativo registrato.";
            console.log(`[PG] ➕ ${evt.name}: ${safeDesc}`);
            // Signature: (campaignId: number, charName: string, sessionId: string, description: string, type: string)
            addCharacterEvent(campaignId, evt.name, sessionId, safeDesc, evt.type || 'GROWTH');
            // Signature: (campaignId: number, sessionId: string, charName: string, event: string, type: string)
            await ingestBioEvent(campaignId, sessionId, evt.name, safeDesc, 'PG');
            markCharacterDirtyByName(campaignId, evt.name);
        }

        // NPC events
        for (const evt of validated.npc_events.keep) {
            const safeDesc = evt.event || "Interazione rilevante registrata.";
            console.log(`[NPC] ➕ ${evt.name}: ${safeDesc}`);
            // Signature: (campaignId: number, npcName: string, sessionId: string, description: string, type: string)
            addNpcEvent(campaignId, evt.name, sessionId, safeDesc, evt.type || 'EVENT');
            // Signature: (campaignId: number, sessionId: string, charName: string, event: string, type: string)
            await ingestBioEvent(campaignId, sessionId, evt.name, safeDesc, 'NPC');
            markNpcDirty(campaignId, evt.name);
        }

        // World events
        for (const evt of validated.world_events.keep) {
            const safeDesc = evt.event || "Evento mondiale registrato.";
            console.log(`[World] ➕ ${safeDesc}`);
            // Signature: (campaignId: number, sessionId: string | null, description: string, type: string, year?: number)
            addWorldEvent(campaignId, sessionId, safeDesc, evt.type || 'EVENT');
            // Signature: (campaignId: number, sessionId: string, event: string, type: string)
            await ingestWorldEvent(campaignId, sessionId, safeDesc, evt.type || 'EVENT');
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

                addLoot(campaignId, finalName, item.quantity || 1, sessionId, itemDesc);

                // 🆕 History Tracking
                addInventoryEvent(campaignId, finalName, sessionId, `Acquisito: ${itemDesc || 'Nessuna descrizione'}`, 'LOOT');

                // Skip simple currency from RAG
                const isSimpleCurrency = /^[\d\s]+(mo|monete?|oro|argent|ram|pezz)/i.test(finalName) && finalName.length < 30;
                if (!isSimpleCurrency) {
                    await ingestLootEvent(campaignId, sessionId, {
                        ...item,
                        name: finalName
                    });
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
                addInventoryEvent(campaignId, finalName, sessionId, `Rimosso/Usato: ${item.description || 'Nessuna descrizione'}`, 'USE');

                // Also ingest in RAG to track WHY it was removed
                await ingestLootEvent(campaignId, sessionId, {
                    ...item,
                    name: `[RIMOSSO/USATO] ${finalName}`
                });
            }
        }

        // Quests
        for (const quest of validated.quests.keep) {
            // Handle both string and object formats for backward compatibility
            const title = typeof quest === 'string' ? quest : quest.title;
            const description = typeof quest === 'string' ? '' : quest.description;
            const status = typeof quest === 'string' ? 'OPEN' : (quest.status || 'OPEN');

            console.log(`[Quest] ➕ ${title} (${status})`);

            // Signature: (campaignId: number, title: string, sessionId?: string, description?: string, status?: string, type?: string)
            addQuest(campaignId, title, sessionId, description, status, quest.type || 'MAJOR');

            // 🆕 History Tracking
            addQuestEvent(campaignId, title, sessionId, description || `Quest aggiornata: ${status}`, status === 'OPEN' ? 'PROGRESS' : status);
        }
    }

    /**
     * Processes NPC dossier updates
     */
    private async processNpcDossierUpdates(campaignId: number, sessionId: string, npcUpdates: any[]): Promise<void> {
        console.log(`[NPC Dossier] 📋 Aggiornamento ${npcUpdates.length} schede NPC...`);

        const dedupedNpcs = await deduplicateNpcBatch(npcUpdates);
        for (const npc of dedupedNpcs) {
            if (npc.name && npc.description) {
                // Name Cleaning
                const clean = cleanEntityName(npc.name);
                const npcName = clean.name;
                const npcDesc = clean.extra ? `${npc.description} (Nota: ${clean.extra})` : npc.description;

                // Signature: (campaignId: number, newName: string, newDescription: string = "")
                const reconciled = await reconcileNpcName(campaignId, npcName, npcDesc);
                const finalName = reconciled ? reconciled.canonicalName : npcName;
                if (reconciled) console.log(`[NPC Dossier] 🔄 Riconciliato: "${npc.name}" → "${finalName}"`);

                // Get existing bio and merge with new one
                const existing = getNpcEntry(campaignId, finalName);
                const oldBio = existing?.description || '';
                // Signature: (bio1: string, bio2: string)
                const mergedBio = await smartMergeBios(oldBio, npcDesc);

                // Signature: (campaignId: number, name: string, description: string, role?: string, status?: string, sessionId?: string)
                updateNpcEntry(campaignId, finalName, mergedBio, npc.role, npc.status, sessionId);
                markNpcDirty(campaignId, finalName);
            }
        }
    }

    /**
     * Processes location updates
     */
    private async processLocationUpdates(campaignId: number, sessionId: string, locationUpdates: any[]): Promise<void> {
        if (!locationUpdates?.length) return;

        console.log(`[Atlas] 🗺️ Aggiornamento ${locationUpdates.length} luoghi...`);

        const dedupedLocations = await deduplicateLocationBatch(locationUpdates);
        for (const loc of dedupedLocations) {
            if (loc.macro && loc.description) {
                const reconciled = await reconcileLocationName(campaignId, loc.macro, loc.micro, loc.description);

                if (reconciled) {
                    console.log(`[Atlas] 🔄 Riconciliato: "${loc.macro}" / "${loc.micro}" → "${reconciled.canonicalMacro}" / "${reconciled.canonicalMicro}"`);
                    updateAtlasEntry(campaignId, reconciled.canonicalMacro, reconciled.canonicalMicro, loc.description, sessionId);
                    markAtlasDirty(campaignId, reconciled.canonicalMacro, reconciled.canonicalMicro);
                } else {
                    updateAtlasEntry(campaignId, loc.macro, loc.micro, loc.description, sessionId);
                    markAtlasDirty(campaignId, loc.macro, loc.micro);
                }
            }
        }
    }

    /**
     * Processes monster encounters
     */
    private async processMonsters(campaignId: number, sessionId: string, monsters: any[]): Promise<void> {
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
                    monsterName
                );

                // 🆕 History Tracking
                addBestiaryEvent(campaignId, finalName, sessionId, `Incontro: ${monsterDesc || 'Nessuna descrizione'}`, 'ENCOUNTER');
            }
        }
    }

    /**
     * Syncs dirty entities to RAG
     */
    async syncDirtyEntities(campaignId: number, validated: any, result: any, channel?: TextChannel): Promise<void> {
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
                if (channel && charSyncResult.names.length > 0) {
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
        } catch (e) {
            console.error('[Sync] ⚠️ Errore batch sync:', e);
        }
    }
}
