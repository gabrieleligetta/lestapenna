import { EmbedBuilder, TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import {
    getAvailableSessions,
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
    getSessionCampaignId,
    getSessionCampaignId as getSessionCampaignIdFromDb,
    markCharacterDirtyByName,
    markNpcDirty,
    markAtlasDirty
} from '../../db';
import {
    generateSummary,
    TONES,
    ToneKey,
    prepareCleanText,
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
} from '../../bard';
import { monitor } from '../../monitor';
import { processSessionReport, sendSessionRecap } from '../../reporter';
import { normalizeSummaryNames } from '../../utils/normalize';
import { publishSummary } from '../../publisher';

export const narrateCommand: Command = {
    name: 'narrate',
    aliases: ['racconta', 'summarize'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args, activeCampaign, client } = ctx;
        const targetSessionId = args[0];
        const requestedTone = args[1]?.toUpperCase() as ToneKey;

        if (!targetSessionId) {
            // Mostra sessioni della campagna attiva
            const sessions = getAvailableSessions(message.guild!.id, activeCampaign?.id);
            if (sessions.length === 0) {
                await message.reply("Nessuna sessione trovata per questa campagna.");
                return;
            }
            const list = sessions.map(s => `🆔 \`${s.session_id}\`\n📅 ${new Date(s.start_time).toLocaleString()} (${s.fragments} frammenti)`).join('\n\n');
            const embed = new EmbedBuilder().setTitle(`📜 Sessioni: ${activeCampaign?.name}`).setDescription(list);
            await message.reply({ embeds: [embed] });
            return;
        }

        if (requestedTone && !TONES[requestedTone]) {
            await message.reply(`Tono non valido. Toni: ${Object.keys(TONES).join(', ')}`);
            return;
        }

        const channel = message.channel as TextChannel;
        await channel.send(`📜 Il Bardo sta consultando gli archivi per la sessione \`${targetSessionId}\`...`);

        // NUOVO AVVIO MONITORAGGIO TEMPORANEO (se non attivo)
        let monitorStartedByUs = false;
        if (!monitor.isSessionActive()) {
            monitor.startSession(targetSessionId);
            monitorStartedByUs = true;
        }

        const startProcessing = Date.now();

        // FASE 1: PREPARAZIONE TESTO PULITO
        let cleanText: string | undefined;
        try {
            await channel.send("📚 Il Bardo sta preparando il testo...");
            cleanText = prepareCleanText(targetSessionId);

            if (cleanText) {
                console.log(`[Prep] ✅ Testo pulito: ${cleanText.length} caratteri`);
            }
        } catch (prepErr: any) {
            console.error(`⚠️ Errore preparazione ${targetSessionId}:`, prepErr);
            // Non blocchiamo il riassunto
        }

        // FASE 2: RIASSUNTO
        try {
            await channel.send("✍️ Inizio stesura del racconto...");
            let result = await generateSummary(targetSessionId, requestedTone || 'DM', cleanText);

            // NUOVO FASE 2.1: PRE-RECONCILIATION (Normalizzazione Nomi)
            if (activeCampaign) {
                result = await normalizeSummaryNames(activeCampaign.id, result);
            }

            // FASE 2.5: INGESTIONE RAG (con dati dall'Analista)
            try {
                await ingestSessionComplete(targetSessionId, result);
                console.log(`[RAG] ✅ Ingestione completata`);
            } catch (ingestErr: any) {
                console.error(`⚠️ Errore ingestione RAG:`, ingestErr);
            }

            // SALVATAGGIO TITOLO
            updateSessionTitle(targetSessionId, result.title);

            // ============================================
            // GESTIONE EVENTI/LOOT/QUEST CON VALIDAZIONE
            // ============================================

            if (result && activeCampaign) {
                const currentSessionId = targetSessionId;
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
                    // Pre-deduplica batch
                    const dedupedItems = await deduplicateItemBatch(validated.loot.keep);

                    for (const item of dedupedItems) {
                        // Riconcilia con inventario esistente
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

                    // STEP 1: Deduplica DENTRO il batch (es. "Leosin Erantar" + "Leosin Erentar" → 1 solo)
                    const validNpcs = result.npc_dossier_updates.filter((n: any) => n.name && n.description);
                    const dedupedBatch = await deduplicateNpcBatch(validNpcs);

                    // STEP 2: Riconcilia contro il DB esistente
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
                            // Cerca se esiste già un luogo simile
                            const reconciled = await reconcileLocationName(
                                currentCampaignId,
                                loc.macro,
                                loc.micro,
                                loc.description
                            );

                            if (reconciled) {
                                // Usa il nome canonico esistente
                                console.log(`[Cartografo] 🔄 Riconciliato: "${loc.macro} - ${loc.micro}" → "${reconciled.canonicalMacro} - ${reconciled.canonicalMicro}"`);
                                updateAtlasEntry(currentCampaignId, reconciled.canonicalMacro, reconciled.canonicalMicro, loc.description, currentSessionId);
                                markAtlasDirty(currentCampaignId, reconciled.canonicalMacro, reconciled.canonicalMicro);
                            } else {
                                // Nuovo luogo
                                updateAtlasEntry(currentCampaignId, loc.macro, loc.micro, loc.description, currentSessionId);
                                markAtlasDirty(currentCampaignId, loc.macro, loc.micro);
                            }
                        }
                    }
                }

                // --- GESTIONE BESTIARIO (MOSTRI con RICONCILIAZIONE) ---
                if (result.monsters && result.monsters.length > 0) {
                    console.log(`[Bestiario] 👹 Registrazione ${result.monsters.length} creature...`);

                    // 1. Pre-deduplica batch
                    const dedupedMonsters = await deduplicateMonsterBatch(result.monsters);

                    // 2. Riconcilia con bestiario esistente
                    for (const monster of dedupedMonsters) {
                        if (monster.name) {
                            const reconciled = await reconcileMonsterName(currentCampaignId, monster.name, monster.description);

                            const finalName = reconciled ? reconciled.canonicalName : monster.name;
                            if (reconciled) {
                                console.log(`[Bestiario] 🔄 Riconciliato: "${monster.name}" → "${finalName}"`);
                            }

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
            const encounteredNPCs = getSessionEncounteredNPCs(targetSessionId);

            await publishSummary(client, targetSessionId, result.log || [], channel, true, result.title, result.loot, result.quests, result.narrativeBrief, result.monsters, encounteredNPCs);

            // Invia email DM con mostri
            const currentCampaignId = getSessionCampaignIdFromDb(targetSessionId) || activeCampaign?.id;
            if (currentCampaignId) {
                await sendSessionRecap(targetSessionId, currentCampaignId, result.log || [], result.loot, result.loot_removed, result.narrativeBrief, result.narrative, result.monsters);
            }

            // NUOVO REPORT TECNICO CON COSTI
            if (monitorStartedByUs) {
                const metrics = await monitor.endSession();
                if (metrics) {
                    await processSessionReport(metrics);
                }
            } else {
                // Se il monitor era già attivo (sessione live), non lo chiudiamo.
                // Possiamo opzionalmente loggare che i costi sono confluiti nella sessione attiva.
                console.log(`[Racconta] Costi confluiti nella sessione attiva monitorata.`);
            }

        } catch (err: any) {
            console.error(`❌ Errore racconta ${targetSessionId}:`, err);
            await channel.send(`⚠️ Errore durante la generazione del riassunto.`);

            // Se errore, e avevamo aperto il monitor, chiudiamolo comunque per pulizia
            if (monitorStartedByUs) {
                await monitor.endSession();
            }
        }
    }
};
