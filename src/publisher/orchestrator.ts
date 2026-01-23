/**
 * Publisher - Orchestrator (Wait & Logic)
 */

import { Client, TextChannel } from 'discord.js';
import {
    getSessionRecordings,
    getSessionCampaignId,
    getCampaigns,
    updateSessionTitle,
    addCharacterEvent,
    addNpcEvent,
    addWorldEvent,
    addLoot,
    removeLoot,
    addQuest,
    updateNpcEntry,
    updateLocation,
    updateAtlasEntry,
    upsertMonster,
    updateSessionPresentNPCs,
    getSessionEncounteredNPCs,
    markCharacterDirtyByName,
    markNpcDirty,
    markAtlasDirty
} from '../db';
import {
    prepareCleanText,
    generateSummary,
    ingestSessionComplete,
    validateBatch,
    ingestBioEvent,
    ingestWorldEvent,
    ingestLootEvent,
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
    syncAllDirtyAtlas
} from '../bard';
import { normalizeSummaryNames } from '../utils/normalize'; // Questa potrebbe dover essere spostata/aggiornata in futuro
import { audioQueue } from '../services/queue';
import { unloadTranscriptionModels } from '../workers';
import { monitor } from '../monitor';
import { processSessionReport, sendSessionRecap } from '../reporter';
import { publishSummary } from './discord';

export async function waitForCompletionAndSummarize(client: Client, sessionId: string, channel?: TextChannel): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
        const CHECK_INTERVAL = 30000; // 30s
        const MAX_WAIT_TIME = 86400000; // 1 ora max
        const startTime = Date.now();

        const checkCompletion = async () => {
            try {
                // Controlla timeout
                if (Date.now() - startTime > MAX_WAIT_TIME) {
                    console.error(`[Monitor] ⏱️ Timeout sessione ${sessionId} (1h superata)`);
                    if (channel) {
                        await channel.send(`⚠️ Timeout sessione \`${sessionId}\`. Elaborazione interrotta.`);
                    }
                    return reject(new Error('Timeout'));
                }

                // Controlla stato file
                const recordings = getSessionRecordings(sessionId);
                const pending = recordings.filter(r => ['PENDING', 'SECURED', 'QUEUED', 'PROCESSING', 'TRANSCRIBED'].includes(r.status));
                const errors = recordings.filter(r => r.status === 'ERROR');

                if (pending.length > 0) {
                    console.log(`[Monitor] ⏳ Sessione ${sessionId}: ${pending.length} file in elaborazione...`);
                    setTimeout(checkCompletion, CHECK_INTERVAL);
                    return;
                }

                // Tutti completati o con errori
                console.log(`[Monitor] ✅ Sessione ${sessionId}: Tutti i file processati.`);

                // NUOVO INVIA SEGNALE UNLOAD AL PC REMOTO (BLOCCANTE)
                // Mettiamo in pausa la coda per evitare che nuovi job partano mentre scarichiamo il modello
                console.log(`[Monitor] ⏸️ Pausa coda audio per unload modello...`);
                await audioQueue.pause();

                try {
                    await unloadTranscriptionModels();
                } catch (e: any) {
                    console.warn(`[Monitor] ⚠️ Errore durante unload modello: ${e.message}`);
                } finally {
                    console.log(`[Monitor] ▶️ Ripresa coda audio...`);
                    await audioQueue.resume();
                }

                if (errors.length > 0) {
                    console.warn(`[Monitor] ⚠️ ${errors.length} file con errori`);
                }

                // Genera riassunto
                const campaignId = getSessionCampaignId(sessionId);
                const activeCampaign = campaignId ? getCampaigns(channel?.guild.id || '').find(c => c.id === campaignId) : undefined;
                if (!campaignId) {
                    console.error(`[Monitor] ❌ Nessuna campagna per sessione ${sessionId}`);
                    return reject(new Error('No campaign found'));
                }

                if (channel) {
                    await channel.send(`📝 Trascrizione completata. Generazione riassunto...`);
                }

                try {
                    // NUOVO Prepara testo pulito
                    const cleanText = prepareCleanText(sessionId);
                    if (!cleanText) throw new Error("Nessuna trascrizione disponibile");

                    // Genera riassunto (con metadata per ingestione RAG)
                    let result = await generateSummary(sessionId, 'DM', cleanText);

                    // Ingestione RAG con metadata
                    await ingestSessionComplete(sessionId, result);
                    console.log(`[Monitor] 🧠 Memoria RAG aggiornata`);

                    // NUOVO FASE 2.1: PRE-RECONCILIATION (Normalizzazione Nomi)
                    if (activeCampaign) {
                        result = await normalizeSummaryNames(activeCampaign.id, result);
                    }

                    // Salva titolo
                    updateSessionTitle(sessionId, result.title);

                    // ============================================
                    // GESTIONE EVENTI/LOOT/QUEST CON VALIDAZIONE
                    // ============================================

                    if (result && activeCampaign) {
                        const currentSessionId = sessionId;
                        const currentCampaignId = activeCampaign.id;

                        // NUOVO PREPARAZIONE BATCH VALIDATION
                        const batchInput: any = {};

                        if (result.character_growth && result.character_growth.length > 0) {
                            batchInput.character_events = result.character_growth;
                        }

                        if (result.npc_events && result.npc_events.length > 0) {
                            batchInput.npc_events = result.npc_events;
                        }

                        if (result.world_events && result.world_events.length > 0) {
                            batchInput.world_events = result.world_events;
                        }

                        if (result.loot && result.loot.length > 0) {
                            batchInput.loot = result.loot;
                        }

                        if (result.quests && result.quests.length > 0) {
                            batchInput.quests = result.quests;
                        }

                        // Esegui validazione batch se c'è qualcosa da validare
                        let validated: any = null;

                        if (Object.keys(batchInput).length > 0) {
                            console.log('[Validator] 🛡️ Validazione batch in corso...');
                            validated = await validateBatch(currentCampaignId, batchInput);

                            // Log statistiche
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
                                (validated.quests.keep.length);

                            const totalSkipped = totalInput - totalKept;
                            const filterRate = totalInput > 0 ? Math.round((totalSkipped / totalInput) * 100) : 0;

                            console.log(`[Validator] ✅ Validazione completata:`);
                            console.log(`  - Accettati: ${totalKept}/${totalInput}`);
                            console.log(`  - Filtrati: ${totalSkipped} (${filterRate}%)`);

                            if (validated.npc_events.skip.length > 0) {
                                console.log(`  - Eventi NPC scartati: ${validated.npc_events.skip.slice(0, 3).join('; ')}${validated.npc_events.skip.length > 3 ? '...' : ''}`);
                            }
                        }

                        // --- GESTIONE EVENTI PG ---
                        if (validated?.character_events.keep && validated.character_events.keep.length > 0) {
                            for (const evt of validated.character_events.keep) {
                                addCharacterEvent(currentCampaignId, evt.name, currentSessionId, evt.event, evt.type);
                                console.log(`[Storia PG] ✍️ ${evt.name}: ${evt.event.substring(0, 50)}...`);

                                // ✅ Marca PG come dirty per sync lazy (Sistema Armonico)
                                markCharacterDirtyByName(currentCampaignId, evt.name);

                                // RAG (invariato)
                                ingestBioEvent(currentCampaignId, currentSessionId, evt.name, evt.event, evt.type)
                                    .catch(err => console.error(`[RAG] Errore PG ${evt.name}:`, err));
                            }
                        }

                        // --- GESTIONE EVENTI NPC ---
                        if (validated?.npc_events.keep && validated.npc_events.keep.length > 0) {
                            for (const evt of validated.npc_events.keep) {
                                addNpcEvent(currentCampaignId, evt.name, currentSessionId, evt.event, evt.type);
                                console.log(`[Storia NPC] ✍️ ${evt.name}: ${evt.event.substring(0, 50)}...`);

                                // ✅ Marca NPC come dirty per sync lazy
                                markNpcDirty(currentCampaignId, evt.name);

                                // RAG
                                ingestBioEvent(currentCampaignId, currentSessionId, evt.name, evt.event, evt.type)
                                    .catch(err => console.error(`[RAG] Errore NPC ${evt.name}:`, err));
                            }
                        }

                        // --- GESTIONE EVENTI MONDO ---
                        if (validated?.world_events.keep && validated.world_events.keep.length > 0) {
                            for (const evt of validated.world_events.keep) {
                                addWorldEvent(currentCampaignId, currentSessionId, evt.event, evt.type);
                                console.log(`[Cronaca] 🌍 ${evt.event.substring(0, 60)}...`);

                                // RAG
                                ingestWorldEvent(currentCampaignId, currentSessionId, evt.event, evt.type)
                                    .catch(err => console.error('[RAG] Errore Mondo:', err));
                            }
                        }

                        // --- GESTIONE LOOT (con RICONCILIAZIONE) ---
                        if (validated?.loot.keep && validated.loot.keep.length > 0) {
                            const dedupedItems = await deduplicateItemBatch(validated.loot.keep);

                            for (const item of dedupedItems) {
                                const reconciled = await reconcileItemName(currentCampaignId, item);
                                const finalName = reconciled ? reconciled.canonicalName : item;
                                if (reconciled) console.log(`[Tesoriere] 🔄 Riconciliato: "${item}" → "${finalName}"`);

                                addLoot(currentCampaignId, finalName, 1);
                                console.log(`[Tesoriere] 💰 Aggiunto: ${finalName}`);

                                // ✅ Embedding selettivo: solo se NON è valuta semplice
                                const isSimpleCurrency = /^[\d\s]+(mo|monete?|oro|argent|ram|pezz)/i.test(finalName) && finalName.length < 30;

                                if (!isSimpleCurrency) {
                                    try {
                                        await ingestLootEvent(currentCampaignId, currentSessionId, finalName);
                                    } catch (err: any) {
                                        console.error(`[RAG] Errore indicizzazione ${finalName}:`, err.message);
                                    }
                                }
                            }
                        }

                        // --- RIMOZIONE LOOT ---
                        if (result.loot_removed && result.loot_removed.length > 0) {
                            result.loot_removed.forEach((item: string) => {
                                removeLoot(currentCampaignId, item);
                                console.log(`[Tesoriere] 🗑️ Rimosso: ${item}`);
                            });
                        }

                        // --- GESTIONE QUEST ---
                        if (validated?.quests.keep && validated.quests.keep.length > 0) {
                            for (const quest of validated.quests.keep) {
                                addQuest(currentCampaignId, quest);
                                console.log(`[Notaio] 🎯 Quest aggiunta: ${quest}`);
                            }
                        }

                        // ============================================
                        // NUOVO ARCHITETTURA UNIFICATA: METADATI ESTRATTI
                        // ============================================

                        // --- GESTIONE NPC DOSSIER (con dedup batch + riconciliazione DB) ---
                        if (result.npc_dossier_updates && result.npc_dossier_updates.length > 0) {
                            console.log(`[Biografo] 📝 Processamento ${result.npc_dossier_updates.length} NPC...`);

                            const validNpcs = result.npc_dossier_updates.filter((n: any) => n.name && n.description);
                            const dedupedBatch = await deduplicateNpcBatch(validNpcs);

                            for (const npc of dedupedBatch) {
                                const reconciled = await reconcileNpcName(currentCampaignId, npc.name, npc.description);
                                if (reconciled) {
                                    console.log(`[Biografo] 🔄 DB Merge: "${npc.name}" → "${reconciled.canonicalName}"`);
                                    const mergedDesc = await smartMergeBios(reconciled.existingNpc.description || '', npc.description);
                                    updateNpcEntry(currentCampaignId, reconciled.canonicalName, mergedDesc, npc.role || reconciled.existingNpc.role, npc.status || reconciled.existingNpc.status, currentSessionId);
                                    markNpcDirty(currentCampaignId, reconciled.canonicalName);
                                } else {
                                    updateNpcEntry(currentCampaignId, npc.name, npc.description, npc.role, npc.status, currentSessionId);
                                    markNpcDirty(currentCampaignId, npc.name);
                                }
                            }
                        }

                        // --- NUOVO TRAVEL SEQUENCE (GPS - Traccia spostamenti cronologici) ---
                        if (result.travel_sequence && result.travel_sequence.length > 0) {
                            console.log(`[GPS] 📍 Tracciamento ${result.travel_sequence.length} spostamenti...`);
                            for (const step of result.travel_sequence) {
                                if (step.macro && step.micro) {
                                    // Riconciliazione Fuzzy + AI per evitare duplicati (es. "Cancello" vs "Cancelli")
                                    const reconciled = await reconcileLocationName(currentCampaignId, step.macro, step.micro);

                                    if (reconciled) {
                                        console.log(`[GPS] 🔄 Riconciliato: "${step.macro} - ${step.micro}" → "${reconciled.canonicalMacro} - ${reconciled.canonicalMicro}"`);
                                        updateLocation(currentCampaignId, reconciled.canonicalMacro, reconciled.canonicalMicro, currentSessionId);
                                    } else {
                                        updateLocation(currentCampaignId, step.macro, step.micro, currentSessionId);
                                    }

                                    console.log(`[GPS] → ${step.macro} - ${step.micro}${step.reason ? ` (${step.reason})` : ''}`);
                                    await new Promise(r => setTimeout(r, 100)); // Delay per timestamp univoci
                                }
                            }
                        } else if (result.location_updates && result.location_updates.length > 0) {
                            // Fallback: usa primo location_update come posizione finale
                            const fallbackLoc = result.location_updates[0];
                            if (fallbackLoc.macro && fallbackLoc.micro) {
                                // Riconciliazione anche per il fallback
                                const reconciled = await reconcileLocationName(currentCampaignId, fallbackLoc.macro, fallbackLoc.micro);

                                if (reconciled) {
                                    console.log(`[GPS] 🔄 Fallback Riconciliato: "${fallbackLoc.macro} - ${fallbackLoc.micro}" → "${reconciled.canonicalMacro} - ${reconciled.canonicalMicro}"`);
                                    updateLocation(currentCampaignId, reconciled.canonicalMacro, reconciled.canonicalMicro, currentSessionId);
                                } else {
                                    updateLocation(currentCampaignId, fallbackLoc.macro, fallbackLoc.micro, currentSessionId);
                                }
                                console.log(`[GPS] 📍 Fallback posizione: ${fallbackLoc.macro} - ${fallbackLoc.micro}`);
                            }
                        }

                        // --- GESTIONE LOCATIONS (ATLANTE - Descrizioni luoghi con RICONCILIAZIONE) ---
                        if (result.location_updates && result.location_updates.length > 0) {
                            console.log(`[Cartografo] 🗺️ Aggiornamento ${result.location_updates.length} descrizioni atlante...`);

                            // 1. Pre-deduplica batch (rimuove duplicati interni)
                            const dedupedLocations = await deduplicateLocationBatch(result.location_updates);

                            // 2. Per ogni location, riconcilia con l'atlante esistente
                            for (const loc of dedupedLocations) {
                                if (loc.macro && loc.micro && loc.description) {
                                    const reconciled = await reconcileLocationName(
                                        currentCampaignId,
                                        loc.macro,
                                        loc.micro,
                                        loc.description
                                    );

                                    if (reconciled) {
                                        console.log(`[Cartografo] 🔄 Riconciliato: "${loc.macro} - ${loc.micro}" → "${reconciled.canonicalMacro} - ${reconciled.canonicalMicro}"`);
                                        updateAtlasEntry(currentCampaignId, reconciled.canonicalMacro, reconciled.canonicalMicro, loc.description, currentSessionId);
                                        markAtlasDirty(currentCampaignId, reconciled.canonicalMacro, reconciled.canonicalMicro);
                                    } else {
                                        updateAtlasEntry(currentCampaignId, loc.macro, loc.micro, loc.description, currentSessionId);
                                        markAtlasDirty(currentCampaignId, loc.macro, loc.micro);
                                    }
                                }
                            }
                        }

                        // --- GESTIONE BESTIARIO (MOSTRI con RICONCILIAZIONE) ---
                        if (result.monsters && result.monsters.length > 0) {
                            console.log(`[Bestiario] 👹 Registrazione ${result.monsters.length} creature...`);

                            const dedupedMonsters = await deduplicateMonsterBatch(result.monsters);
                            for (const monster of dedupedMonsters) {
                                if (monster.name) {
                                    const reconciled = await reconcileMonsterName(currentCampaignId, monster.name, monster.description);
                                    const finalName = reconciled ? reconciled.canonicalName : monster.name;
                                    if (reconciled) console.log(`[Bestiario] 🔄 Riconciliato: "${monster.name}" → "${finalName}"`);

                                    upsertMonster(
                                        currentCampaignId,
                                        finalName,
                                        monster.status || 'ALIVE',
                                        monster.count,
                                        currentSessionId,
                                        {
                                            description: monster.description,
                                            abilities: monster.abilities,
                                            weaknesses: monster.weaknesses,
                                            resistances: monster.resistances
                                        }
                                    );
                                }
                            }
                        }

                        // --- GESTIONE NPC INCONTRATI (per tabella "NPC Incontrati") ---
                        if (result.present_npcs && result.present_npcs.length > 0) {
                            updateSessionPresentNPCs(currentSessionId, result.present_npcs);
                        }

                        // NUOVO SYNC RAG A FINE SESSIONE (Batch automatico)
                        // Condizione espansa per includere metadati unificati (npc_dossier_updates, location_updates)
                        const hasValidatedEvents = validated && (validated.npc_events.keep.length > 0 || validated.character_events.keep.length > 0);
                        const hasNewMetadata = (result.npc_dossier_updates?.length || 0) > 0 || (result.location_updates?.length || 0) > 0;

                        if (hasValidatedEvents || hasNewMetadata) {
                            console.log('[Sync] 📊 Controllo NPC, PG e Atlante da sincronizzare...');
                            try {
                                // Sync NPC (include sia npc_events che npc_dossier_updates)
                                const syncedNpcCount = await syncAllDirtyNpcs(currentCampaignId);
                                if (syncedNpcCount > 0) {
                                    console.log(`[Sync] ✅ Sincronizzati ${syncedNpcCount} NPC con RAG.`);
                                }

                                // Sync PG (Sistema Armonico)
                                const charSyncResult = await syncAllDirtyCharacters(currentCampaignId);
                                if (charSyncResult.synced > 0) {
                                    console.log(`[Sync] ✅ Sincronizzati ${charSyncResult.synced} PG: ${charSyncResult.names.join(', ')}`);

                                    // Notifica nel canale (opzionale)
                                    if (channel && charSyncResult.names.length > 0) {
                                        channel.send(`📜 **Schede Aggiornate Automaticamente**\n${charSyncResult.names.map(n => `• ${n}`).join('\n')}`).catch(() => { });
                                    }
                                }

                                // NUOVO Sync Atlas (location_updates)
                                if (result.location_updates?.length) {
                                    const syncedAtlasCount = await syncAllDirtyAtlas(currentCampaignId);
                                    if (syncedAtlasCount > 0) {
                                        console.log(`[Sync] ✅ Sincronizzati ${syncedAtlasCount} luoghi con RAG.`);
                                    }
                                }
                            } catch (e) {
                                console.error('[Sync] ⚠️ Errore batch sync:', e);
                            }
                        }
                    }

                    // NUOVO Recupera NPC incontrati
                    const encounteredNPCs = getSessionEncounteredNPCs(sessionId);

                    // Pubblica in Discord
                    if (channel) {
                        await publishSummary(client, sessionId, result.log || [], channel, false, result.title, result.loot, result.quests, result.narrativeBrief, result.monsters, encounteredNPCs);
                    }

                    // Invia email DM
                    await sendSessionRecap(sessionId, campaignId, result.log || [], result.loot, result.loot_removed, result.narrativeBrief, result.narrative, result.monsters);

                    // NUOVO LOG DEBUG
                    console.log('[Monitor] 📊 DEBUG: Inizio chiusura sessione e invio metriche...');

                    // CHIUSURA SESSIONE E INVIO REPORT TECNICO
                    const metrics = await monitor.endSession();

                    console.log('[Monitor] 📊 DEBUG: monitor.endSession() completato', {
                        hasMetrics: !!metrics,
                        sessionId: metrics?.sessionId
                    });

                    if (metrics) {
                        console.log('[Monitor] 📊 DEBUG: Invio report via processSessionReport()...');

                        try {
                            await processSessionReport(metrics);
                            console.log('[Monitor] ✅ Report metriche inviato con successo');
                        } catch (e: any) {
                            console.error('[Monitor] ❌ ERRORE INVIO REPORT:', e.message);
                            console.error('[Monitor] ❌ Stack:', e.stack);

                            // Informa in chat (opzionale)
                            if (channel) {
                                await channel.send(`⚠️ Report tecnico fallito: ${e.message}`);
                            }
                        }
                    } else {
                        console.warn('[Monitor] ⚠️ DEBUG: metrics è null/undefined!');
                    }

                    // Se è una sessione di test, avvisiamo in chat
                    if (sessionId.startsWith("test-") && channel) {
                        await channel.send("✅ Report sessione di test inviato via email!");
                    }

                    console.log(`[Monitor] ✅ Sessione ${sessionId} completata!`);

                    // NUOVO RISOLVI LA PROMISE
                    resolve();

                } catch (err: any) {
                    console.error(`[Monitor] ❌ Errore generazione riassunto:`, err);
                    if (channel) {
                        await channel.send(`❌ Errore generazione riassunto: ${err.message}`);
                    }
                    reject(err);
                }

            } catch (err: any) {
                console.error(`[Monitor] ❌ Errore check:`, err);
                reject(err);
            }
        };

        // Avvia il check
        checkCompletion();
    });
}
