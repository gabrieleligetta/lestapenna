/**
 * Context hydration: the PC cast, the Scout phase (extraction of candidate entities),
 * batch reconciliation and assembly of the dynamic context for the Analyst.
 * Blocks moved verbatim from the generateSummary monolith.
 */

import {
    getUserProfile,
    getCampaignById,
    getCampaignSnapshot,
    getAllNpcs,
    getArtifactByName,
    npcRepository,
    locationRepository,
    factionRepository
} from '../../db';
import { getMetadataClient } from '../config';
import { generateJson } from '../llm/generate';
import { SCOUT_PROMPT } from '../prompts';
import { searchKnowledge } from '../rag';
import {
    buildEntityIndex,
    batchReconcile,
    type EntityToReconcile,
    type ReconciliationContext
} from '../reconciliation';
import { augmentNpcNamesFromAppositions, augmentNpcNamesFromKnownMentions } from '../entityExtraction';
import { reconcileQuestTitle } from '../reconciliation/quest';

/**
 * Builds the cast context (PCs + party) and collects the PC names
 * so they can be excluded from the Scout.
 */
export function buildCastContext(
    transcriptions: any[],
    campaignId: number | null,
    partyFaction: any
): { castContext: string; playerCharacterNames: string[] } {
    const userIds = new Set(transcriptions.map((t: any) => t.user_id));
    let castContext = "CHARACTERS (Use this info to enrich the narration):\n";

    // Collect player character names for Scout exclusion
    const playerCharacterNames: string[] = [];

    if (campaignId) {
        const campaign = getCampaignById(campaignId);
        if (campaign) castContext += `CAMPAIGN: ${campaign.name}\n`;
        userIds.forEach(uid => {
            const p = getUserProfile(uid, campaignId);
            if (p.character_name) {
                playerCharacterNames.push(p.character_name); // 🆕 Collect for Scout
                let charInfo = `- **${p.character_name}**`;
                const details = [];
                if (p.race) details.push(p.race);
                if (p.class) details.push(p.class);
                if (details.length > 0) charInfo += ` (${details.join(' ')})`;
                // 🆕 Add alignment info
                const moralLabel = (p as any).alignment_moral || 'NEUTRAL';
                const ethicalLabel = (p as any).alignment_ethical || 'NEUTRAL';
                const moralScore = (p as any).moral_score ?? 0;
                const ethicalScore = (p as any).ethical_score ?? 0;
                charInfo += ` [Alignment: ${ethicalLabel} ${moralLabel} (M:${moralScore >= 0 ? '+' : ''}${moralScore}, E:${ethicalScore >= 0 ? '+' : ''}${ethicalScore})]`;
                if (p.description) charInfo += `: "${p.description}"`;
                castContext += charInfo + "\n";
            }
        });

        // Always include party name + alignment
        if (partyFaction) {
            const pMoral = partyFaction.alignment_moral || 'NEUTRAL';
            const pEthical = partyFaction.alignment_ethical || 'NEUTRAL';
            const pMoralScore = partyFaction.moral_score ?? 0;
            const pEthicalScore = partyFaction.ethical_score ?? 0;
            castContext += `\n🎭 GROUP OF HEROES (PARTY): **${partyFaction.name}** [ID: ${partyFaction.short_id || 'N/A'}] [Alignment: ${pEthical} ${pMoral} (M:${pMoralScore >= 0 ? '+' : ''}${pMoralScore}, E:${pEthicalScore >= 0 ? '+' : ''}${pEthicalScore})]\n`;
        }
    }

    return { castContext, playerCharacterNames };
}

/**
 * Scout phase + batch reconciliation + hydration: produces the dynamic
 * context (the entities detected) for the Analyst and the Writer.
 */
export async function buildDynamicMemoryContext(
    campaignId: number,
    fullDialogue: string,
    playerCharacterNames: string[],
    partyFaction: any
): Promise<string> {
    let dynamicMemoryContext = "";
    console.log(`[Bardo] 🧠 Avvio Scout Phase...`);

    if (process.env.AGENTIC_SKIP_SCOUT === 'true') {
        console.log('[Bardo] ⏩ Scout saltata da AGENTIC_SKIP_SCOUT=true; uso contesto base DB/RAG.');
        const snapshot = getCampaignSnapshot(campaignId);
        dynamicMemoryContext = `\n[[BASE CONTEXT (SCOUT SKIP)]]\n📍 LOCATION: ${snapshot.location_context}\n⚔️ QUESTS: ${snapshot.quest_context || 'N/A'}\n`;
        if (partyFaction) {
            dynamicMemoryContext += `\n🎭 PARTY FACTION: ${partyFaction.name} [ID: ${partyFaction.short_id || 'N/A'}] ${partyFaction.description || ''}\n`;
        }
    } else {
    try {
        // 1. Run the Scout (excluding the PCs)
        console.log(`[Bardo] 🕵️ Scout esclude PG: ${playerCharacterNames.join(', ') || 'nessuno'}`);
        const scoutAi = await generateJson({
            route: await getMetadataClient(),
            label: 'metadata',
            system: 'You are a D&D archival scout. Extract only candidate entities from the text. Answer ONLY with valid JSON.',
            prompt: SCOUT_PROMPT(fullDialogue, playerCharacterNames),
            maxTokensNative: 8000
        });

        const entities = scoutAi.parsed || { npcs: [], locations: [], quests: [], factions: [], artifacts: [] };
        if (Array.isArray(entities.npcs)) {
            entities.npcs = augmentNpcNamesFromAppositions(fullDialogue, entities.npcs);
        }
        console.log(`[Bardo] 🕵️ Scout ha trovato: ${entities.npcs?.length || 0} NPC, ${entities.locations?.length || 0} Luoghi, ${entities.factions?.length || 0} Fazioni, ${entities.artifacts?.length || 0} Artefatti.`);

        // ============================================
        // 🆕 BATCH RECONCILIATION SYSTEM
        // Replaces individual reconcile calls with one batch
        // ============================================

        // Build entity index once (local, no API call)
        const entityIndex = buildEntityIndex(campaignId);

        if (Array.isArray(entities.npcs)) {
            entities.npcs = augmentNpcNamesFromKnownMentions(fullDialogue, entities.npcs, getAllNpcs(campaignId));
        }

        // Get current location context for smarter matching
        const snapshot = getCampaignSnapshot(campaignId);
        const [currentMacro, currentMicro] = (snapshot.location_context || '').split(' - ').map((s: string) => s.trim());

        const reconcileContext: ReconciliationContext = {
            currentMacro: currentMacro || undefined,
            currentMicro: currentMicro || undefined
        };

        // Prepare all entities for batch reconciliation
        const entitiesToReconcile: EntityToReconcile[] = [];

        // Add NPCs
        if (entities.npcs && Array.isArray(entities.npcs)) {
            for (const name of entities.npcs) {
                entitiesToReconcile.push({ name, type: 'npc' });
            }
        }

        // Add Locations
        if (entities.locations && Array.isArray(entities.locations)) {
            for (const name of entities.locations) {
                // Parse location format: "Macro - Micro" or just "Micro"
                let macro = currentMacro || '';
                let micro = name;
                if (name.includes(' - ')) {
                    const parts = name.split(' - ');
                    macro = parts[0].trim() || currentMacro || '';
                    micro = parts.slice(1).join(' - ').trim();
                }
                entitiesToReconcile.push({ name, type: 'location', macro, micro });
            }
        }

        // Add Factions
        if (entities.factions && Array.isArray(entities.factions)) {
            for (const name of entities.factions) {
                entitiesToReconcile.push({ name, type: 'faction' });
            }
        }

        // Add Artifacts
        if (entities.artifacts && Array.isArray(entities.artifacts)) {
            for (const name of entities.artifacts) {
                entitiesToReconcile.push({ name, type: 'artifact' });
            }
        }

        // 🚀 SINGLE BATCH CALL for all entities
        const reconcileResults = await batchReconcile(entityIndex, entitiesToReconcile, reconcileContext);

        // ============================================
        // HYDRATE CONTEXT FROM RESULTS
        // The lines are accumulated per section and assembled AFTER the loop:
        // the old approach inserted the headers afterwards with replace/
        // regex over the already concatenated text (fragile: headers in random places).
        // ============================================
        const scoutFactions: string[] = [];
        const foundNpcs = new Set<string>();
        const foundLocs = new Set<string>();
        const foundFactions = new Set<string>();
        const foundArtifacts = new Set<string>();
        const npcLines: string[] = [];
        const locLines: string[] = [];
        const artifactLines: string[] = [];

        // Process reconciliation results
        for (const result of reconcileResults) {
            if (result.isPlayerCharacter) continue; // Skip PCs

            if (result.matched && result.matchedEntity) {
                const entity = result.matchedEntity;

                switch (result.type) {
                    case 'npc':
                        if (!foundNpcs.has(entity.name)) {
                            foundNpcs.add(entity.name);
                            // Get full NPC data from DB
                            const npc = npcRepository.getNpcByShortId(campaignId, entity.shortId || '');
                            if (npc) {
                                let npcLine = `- **${npc.name}** [ID: ${npc.short_id || 'N/A'}] (${npc.role || 'No role'}): ${(npc.description || 'No description.').substring(0, 200)} [Status: ${npc.status || 'ALIVE'}]`;
                                const npcMoralScore = (npc as any).moral_score ?? 0;
                                const npcEthicalScore = (npc as any).ethical_score ?? 0;
                                if (npcMoralScore !== 0 || npcEthicalScore !== 0 || (npc as any).alignment_moral || (npc as any).alignment_ethical) {
                                    npcLine += ` [Alignment: ${(npc as any).alignment_ethical || 'NEUTRAL'} ${(npc as any).alignment_moral || 'NEUTRAL'} (M:${npcMoralScore >= 0 ? '+' : ''}${npcMoralScore}, E:${npcEthicalScore >= 0 ? '+' : ''}${npcEthicalScore})]`;
                                }
                                npcLines.push(npcLine);

                                // Collect factions from NPC affiliations
                                const affiliations = factionRepository.getEntityFactions('npc', npc.id);
                                for (const aff of affiliations) {
                                    if (aff.faction_name && !scoutFactions.includes(aff.faction_name)) {
                                        scoutFactions.push(aff.faction_name);
                                    }
                                }
                            }
                        }
                        break;

                    case 'location':
                        const locKey = `${entity.macro} - ${entity.micro}`;
                        if (!foundLocs.has(locKey)) {
                            foundLocs.add(locKey);
                            const loc = locationRepository.getAtlasEntryFull(campaignId, entity.macro || '', entity.micro || '');
                            if (loc) {
                                locLines.push(`- **${locKey}** [ID: ${loc.short_id || 'N/A'}]: ${(loc.description || 'No description.').substring(0, 200)}`);

                                // Collect factions from location affiliations
                                const affiliations = factionRepository.getEntityFactions('location', loc.id);
                                for (const aff of affiliations) {
                                    if (aff.faction_name && !scoutFactions.includes(aff.faction_name)) {
                                        scoutFactions.push(aff.faction_name);
                                    }
                                }
                            }
                        }
                        break;

                    case 'faction':
                        if (!foundFactions.has(entity.name)) {
                            foundFactions.add(entity.name);
                            // Will be processed below with party faction
                        }
                        break;

                    case 'artifact':
                        if (!foundArtifacts.has(entity.name)) {
                            foundArtifacts.add(entity.name);
                            try {
                                const artifact = getArtifactByName(campaignId, entity.name);
                                if (artifact) {
                                    let artifactInfo = `- **${artifact.name}** [ID: ${artifact.short_id || 'N/A'}]: ${(artifact.description || 'No description.').substring(0, 200)}`;
                                    if (artifact.is_cursed) artifactInfo += ` [CURSED]`;
                                    if (artifact.owner_name) artifactInfo += ` [Owner: ${artifact.owner_name}]`;
                                    artifactLines.push(artifactInfo);
                                }
                            } catch (e) { /* ignore */ }
                        }
                        break;
                }
            }
        }

        // Assembling the sections (with headers) from the accumulated lines
        dynamicMemoryContext = "\n[[DYNAMIC CONTEXT (DETECTED ENTITIES)]]\n";
        if (npcLines.length > 0) {
            dynamicMemoryContext += `\n👥 NPCS PRESENT (Historical Data):\n${npcLines.join('\n')}\n`;
        }
        if (locLines.length > 0) {
            dynamicMemoryContext += `\n🗺️ MENTIONED LOCATIONS (${locLines.length}):\n${locLines.join('\n')}\n`;
        }
        if (artifactLines.length > 0) {
            dynamicMemoryContext += `\n✨ MENTIONED ARTIFACTS:\n${artifactLines.join('\n')}\n`;
        }

        // Quest hydration (still uses legacy reconciler for now)
        if (entities.quests && Array.isArray(entities.quests) && entities.quests.length > 0) {
            const foundQuests = new Set<string>();
            dynamicMemoryContext += `\n⚔️ RELEVANT QUESTS:\n`;

            for (const title of entities.quests) {
                try {
                    const match = await reconcileQuestTitle(campaignId, title);
                    if (match && !foundQuests.has(match.canonicalTitle)) {
                        foundQuests.add(match.canonicalTitle);
                        const q = match.existingQuest;
                        let questInfo = `- **${q.title}** [ID: ${q.short_id || 'N/A'}]: ${q.description || 'No description.'} [Status: ${q.status}]`;
                        if (q.type) questInfo += ` [${q.type}]`;
                        dynamicMemoryContext += questInfo + '\n';
                    }
                } catch (e) {
                    console.error(`[Bardo] ⚠️ Errore riconciliazione Quest "${title}":`, e);
                }
            }

            if (foundQuests.size === 0) {
                dynamicMemoryContext += `- No matching known quest found.\n`;
            }
        } else {
            dynamicMemoryContext += `\n⚔️ NO QUEST MENTIONED.\n`;
        }

        // Faction hydration (Party + Scout + from NPC/Location affiliations)
        if (partyFaction || scoutFactions.length > 0 || foundFactions.size > 0) {
            dynamicMemoryContext += `\n⚔️ MENTIONED FACTIONS:\n`;

            // Add party faction first
            if (partyFaction) {
                foundFactions.add(partyFaction.name);
                const members = factionRepository.countFactionMembers(partyFaction.id);
                const totalMembers = members.npcs + members.locations + members.pcs;
                const reputation = factionRepository.getFactionReputation(campaignId, partyFaction.id);

                const dmMoral = partyFaction.alignment_moral || 'NEUTRAL';
                const dmEthical = partyFaction.alignment_ethical || 'NEUTRAL';
                const dmMoralScore = partyFaction.moral_score ?? 0;
                const dmEthicalScore = partyFaction.ethical_score ?? 0;
                let factionInfo = `- **${partyFaction.name}** [ID: ${partyFaction.short_id || 'N/A'}] (${partyFaction.type || 'ORGANIZATION'}): ${partyFaction.description || 'No description.'}`;
                factionInfo += ` [Alignment: ${dmEthical} ${dmMoral} (M:${dmMoralScore >= 0 ? '+' : ''}${dmMoralScore}, E:${dmEthicalScore >= 0 ? '+' : ''}${dmEthicalScore})]`;
                if (totalMembers > 0) factionInfo += ` [Members: ${totalMembers}]`;
                if (reputation && reputation !== 'NEUTRAL') factionInfo += ` [Reputation: ${reputation}]`;
                factionInfo += ` [PARTY FACTION]`;
                dynamicMemoryContext += factionInfo + '\n';
            }

            // Add other factions from scout and affiliations
            const allFactionNames = [...new Set([...scoutFactions, ...foundFactions])];
            for (const name of allFactionNames) {
                if (partyFaction && name === partyFaction.name) continue; // Already added
                try {
                    const factions = factionRepository.findFactionByName(campaignId, name);
                    const faction = factions.length > 0 ? factions[0] : null;
                    if (faction) {
                        const members = factionRepository.countFactionMembers(faction.id);
                        const totalMembers = members.npcs + members.locations + members.pcs;
                        const reputation = factionRepository.getFactionReputation(campaignId, faction.id);

                        let factionInfo = `- **${faction.name}** [ID: ${faction.short_id || 'N/A'}] (${faction.type || 'ORGANIZATION'}): ${faction.description || 'No description.'}`;
                        const fMoralScore = faction.moral_score ?? 0;
                        const fEthicalScore = faction.ethical_score ?? 0;
                        if (fMoralScore !== 0 || fEthicalScore !== 0 || faction.alignment_moral || faction.alignment_ethical) {
                            factionInfo += ` [Alignment: ${faction.alignment_ethical || 'NEUTRAL'} ${faction.alignment_moral || 'NEUTRAL'} (M:${fMoralScore >= 0 ? '+' : ''}${fMoralScore}, E:${fEthicalScore >= 0 ? '+' : ''}${fEthicalScore})]`;
                        }
                        if (totalMembers > 0) factionInfo += ` [Members: ${totalMembers}]`;
                        if (reputation && reputation !== 'NEUTRAL') factionInfo += ` [Reputation: ${reputation}]`;
                        dynamicMemoryContext += factionInfo + '\n';
                    }
                } catch (e) {
                    console.error(`[Bardo] ⚠️ Errore idratazione Fazione "${name}":`, e);
                }
            }
        }

        // LOG RIEPILOGATIVO CONTESTO
        console.log(`[Bardo] 📋 Riepilogo Contesto Analista:`);
        if (entities.npcs?.length) console.log(`  - NPCs: ${entities.npcs.join(', ')}`);
        if (entities.locations?.length) console.log(`  - Luoghi: ${entities.locations.join(', ')}`);
        if (entities.quests?.length) console.log(`  - Quest: ${entities.quests.join(', ')}`);
        if (entities.factions?.length) console.log(`  - Fazioni: ${entities.factions.join(', ')}`);
        if (entities.artifacts?.length) console.log(`  - Artefatti: ${entities.artifacts.join(', ')}`);

        // 🆕 DEBUG: print the whole hydrated context (opt-in: in prod it is
        // extremely noisy — the content ends up in debug_prompts anyway)
        if (process.env.DEBUG_HYDRATION === 'true') {
            console.log(`[Bardo] 📝 DETTAGLIO CONTESTO IDRATO:\n${dynamicMemoryContext}\n-----------------------------------`);
        }

        // Fallback location corrente (snapshot already fetched above)
        let locationContext = snapshot.location_context || 'Unknown';

        // 🆕 Try to resolve ID for current location
        if (snapshot.location_context) {
            const [macro, micro] = snapshot.location_context.split(' - ').map((s: string) => s.trim());
            if (macro && micro) {
                const atlasEntry = locationRepository.getAtlasEntryFull(campaignId, macro, micro);
                if (atlasEntry) {
                    locationContext = `${snapshot.location_context} [ID: ${atlasEntry.short_id}]`;
                }
            }
        }
        dynamicMemoryContext += `\n📍 CURRENT LOCATION: ${locationContext}\n`;

        // --- CHARACTER HISTORY PASS ---
        // For each PC in the session, query the RAG for significant past events.
        // This ensures that recurring devices (e.g. disappearances, habits, past traumas)
        // are visible to the analyst regardless of the quality of the current transcript.
        if (playerCharacterNames.length > 0) {
            try {
                const historyResults = await Promise.all(
                    playerCharacterNames.map(async (pgName) => {
                        const fragments = await searchKnowledge(campaignId, pgName, 3);
                        return { pgName, fragments };
                    })
                );
                const historyLines: string[] = [];
                for (const { pgName, fragments } of historyResults) {
                    for (const fragment of fragments) {
                        historyLines.push(`[${pgName}] ${fragment.substring(0, 400)}`);
                    }
                }
                if (historyLines.length > 0) {
                    dynamicMemoryContext += `\n📚 PC HISTORY (PAST EVENTS FROM PREVIOUS SESSIONS):\n${historyLines.join('\n\n')}\n`;
                    console.log(`[Bardo] 📚 Character history: ${historyLines.length} frammenti per ${playerCharacterNames.length} PG`);
                }
            } catch (e) {
                console.warn(`[Bardo] ⚠️ Character history RAG lookup fallito:`, e);
            }
        }

    } catch (e) {
        console.error("[Bardo] ⚠️ Errore fase Scout, fallback a contesto base:", e);
        const snapshot = getCampaignSnapshot(campaignId);
        dynamicMemoryContext = `\n[[BASE CONTEXT (FALLBACK)]]\n📍 LOCATION: ${snapshot.location_context}\n⚔️ QUESTS: ${snapshot.quest_context}\n`;
    }
    }

    console.log(`[Bardo] 💧 Contesto Idrato (${dynamicMemoryContext.length} chars).`);
    return dynamicMemoryContext;
}
