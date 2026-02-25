/**
 * Bard Summary - Narrative and summary generation functions
 */

import {
    getSessionTranscript,
    getSessionNotes,
    getSessionStartTime,
    getSessionCampaignId,
    getUserProfile,
    getCampaignById,
    getCampaignSnapshot,
    listNpcs,
    listAtlasEntries,
    getCampaignCharacters,
    getNpcEntry, // for regenerateNpcNotes
    updateNpcEntry, // ??
    getCharacterHistory, // for generateCharacterBio
    getNpcHistory,
    addSessionLog,
    getSessionLog,
    // Add repositories for hydration
    inventoryRepository,
    questRepository,
    bestiaryRepository,
    npcRepository,
    locationRepository,
    worldRepository,
    factionRepository,
    getSessionAIOutput,
    saveSessionAIOutput
} from '../db';
import * as fs from 'fs';
import * as path from 'path';

import {
    getSummaryClient,
    getMetadataClient,
    getAnalystClient,
    getMapClient,
    EMBEDDING_BATCH_SIZE,
    MAX_CHUNK_SIZE,
    CHUNK_OVERLAP,
    ANALYST_CONTEXT_LIMIT,
    ANALYST_OUTPUT_LIMIT,
    SUMMARY_CONTEXT_LIMIT,
    SUMMARY_OUTPUT_LIMIT
} from './config';

import {
    processInBatches,
    withRetry,
    safeJsonParse,
    normalizeStringList,
    normalizeLootList,
    smartSplitTranscript,
    findBestMatch
} from './helpers';

import {
    SummaryResponse,
    ToneKey,
    AnalystOutput
} from './types';

import { searchKnowledge, ingestSessionComplete } from './rag'; // ingestSessionComplete handles RAG ingestion
import { filterWhisperHallucinations } from '../utils/filters/whisper';
import { monitor } from '../monitor';
import {
    MAP_PROMPT,
    CONTEXT_IDENTIFICATION_PROMPT,
    SCOUT_PROMPT,
    ANALYST_PROMPT,
    WRITER_DM_PROMPT,
    WRITER_BARDO_PROMPT,
} from './prompts';

import { generateBio } from './bio'; // 🆕 Unified Generator

// 🆕 Batch Reconciliation System (efficient)
import {
    buildEntityIndex,
    batchReconcile,
    type EntityToReconcile,
    type ReconciliationContext
} from './reconciliation';

import { getOrCreateManifesto } from './manifesto'; // 🆕 World Manifesto

// Legacy imports (still used for quests)
import { reconcileQuestTitle } from './reconciliation/quest';

// Constants
// Constants
const MAP_CONCURRENCY = 3;

/**
 * Utility: Split text in chunks
 */
function splitTextInChunks(text: string, chunkSize: number = MAX_CHUNK_SIZE, overlap: number = CHUNK_OVERLAP): string[] {
    const chunks: string[] = [];
    let i = 0;
    while (i < text.length) {
        const end = Math.min(i + chunkSize, text.length);
        chunks.push(text.substring(i, end));
        if (end >= text.length) break;
        i = end - overlap;
    }
    return chunks;
}

/**
 * Utility: Normalize location names
 */
function normalizeLocationNames(macro: string, micro: string): { macro: string; micro: string } {
    if (micro.startsWith(macro + " - ")) {
        micro = micro.substring(macro.length + 3);
    }
    return { macro, micro };
}

/**
 * Utility: Save debug file
 */
function saveDebugFile(sessionId: string, filename: string, content: string) {
    try {
        const debugDir = path.join(__dirname, '..', '..', 'transcripts', sessionId, 'debug_prompts');
        if (!fs.existsSync(debugDir)) {
            fs.mkdirSync(debugDir, { recursive: true });
        }
        fs.writeFileSync(path.join(debugDir, filename), content, 'utf-8');
    } catch (e) {
        console.error(`[Debug] Failed to save ${filename}:`, e);
    }
}

/**
 * Utility: Smart Truncate
 */
function smartTruncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    // Semrified logic for now to save space, assuming full logic copied if needed
    // or keep it simple: center cut.
    // Copying full logic as it's important for context.

    // 2. Fallback: 20% start + 80% end (matches the fallback in original codepath)
    const startChunk = text.substring(0, maxChars * 0.2);
    const endChunk = text.substring(text.length - (maxChars * 0.8));

    const lastPeriodStart = startChunk.lastIndexOf('.');
    const cleanStart = lastPeriodStart > 0 ? startChunk.substring(0, lastPeriodStart + 1) : startChunk;

    const firstPeriodEnd = endChunk.indexOf('.');
    const cleanEnd = firstPeriodEnd > 0 ? endChunk.substring(firstPeriodEnd + 1) : endChunk;

    return cleanStart + '\n\n[...SEZIONE CENTRALE OMESSA...]\n\n' + cleanEnd;
}

/**
 * Utility: Process Chronological Session (Reconstructed from view or assumed logic)
 * In Step 906 view, it called processChronologicalSession.
 * It's likely a helper that merges transcript and notes by timestamp.
 */
function processChronologicalSession(transcriptions: any[], notes: any[], startTime: number, campaignId: number) {
    // Basic implementation based on standard logic
    const segments: Array<{ timestamp: number, type: 'TRANSCRIPT' | 'NOTE', text: string, character: string }> = [];

    transcriptions.forEach(t => {
        segments.push({
            timestamp: t.timestamp || 0,
            type: 'TRANSCRIPT',
            text: t.transcription_text,
            character: t.character_name || 'Sconosciuto'
        });
    });

    notes.forEach(n => {
        segments.push({
            timestamp: n.timestamp || 0,
            type: 'NOTE',
            text: n.note_text,
            character: n.author_name || 'Master'
        });
    });

    segments.sort((a, b) => a.timestamp - b.timestamp);

    const linearText = segments.map(s => {
        const timeOffset = s.timestamp - startTime;
        const mins = Math.floor(timeOffset / 60000); // approx
        return `[t=${mins}m] [${s.character}]: ${s.text}`;
    }).join('\n');

    return { segments, linearText };
}

// --- FASE 1: MAP ---
async function extractFactsFromChunk(chunk: string, index: number, total: number, castContext: string): Promise<{ text: string, title: string, tokens: number }> {
    const mapPrompt = MAP_PROMPT.replace('${castContext}', castContext);

    const startAI = Date.now();
    try {
        const { client, model, provider } = await getMapClient();
        const response: any = await withRetry(() => client.chat.completions.create({
            model: model,
            messages: [
                { role: "system", content: mapPrompt },
                { role: "user", content: chunk }
            ],
        }));

        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        monitor.logAIRequestWithCost('map', provider, model, inputTokens, outputTokens, 0, latency, false);

        return {
            text: response.choices[0].message.content || "",
            title: "",
            tokens: response.usage?.total_tokens || 0
        };
    } catch (err) {
        console.error(`[Map] ❌ Errore chunk ${index + 1}:`, err);
        monitor.logAIRequestWithCost('map', 'openai', 'gpt-4o-mini', 0, 0, 0, Date.now() - startAI, true);
        return { text: "", title: "", tokens: 0 };
    }
}

/**
 * ENHANCED identifyRelevantContext - Progressive Density Sampling
 */
async function identifyRelevantContext(
    campaignId: number,
    rawTranscript: string,
    snapshot: any,
    narrativeText?: string
): Promise<string[]> {
    const TARGET_CHARS = 300000;
    const sourceText = narrativeText || rawTranscript;

    const estimatedTokens = Math.ceil(sourceText.length / 2.5);
    const MAX_CONTEXT_TOKENS = 350000;
    const USE_MAP_PHASE = estimatedTokens > MAX_CONTEXT_TOKENS;

    let processedText = sourceText;

    if (USE_MAP_PHASE) {
        console.log(`[MAP] ⚠️ Testo troppo lungo, attivo MAP Phase`);
        const chunks = splitTextInChunks(sourceText, MAX_CHUNK_SIZE, CHUNK_OVERLAP);
        const characters = getCampaignCharacters(campaignId);
        const castContext = characters.length > 0 ? `CAST: ${characters.map((c: any) => c.character_name).join(', ')}` : '';

        const condensedChunks = await processInBatches(chunks, MAP_CONCURRENCY, async (chunk: string, idx: number) => {
            try {
                return await extractFactsFromChunk(chunk, idx, chunks.length, castContext);
            } catch (e) {
                return { text: chunk.substring(0, 5000), title: '', tokens: 0 };
            }
        }, 'MAP Phase');

        processedText = condensedChunks.map((c: any) => c.text).join('\n\n');
    }

    const analysisText = smartTruncate(processedText, TARGET_CHARS);

    const prompt = CONTEXT_IDENTIFICATION_PROMPT(snapshot, analysisText);

    const startAI = Date.now();
    try {
        const { client, model, provider } = await getMetadataClient();
        const response = await client.chat.completions.create({
            model: model,
            messages: [
                { role: "system", content: "Sei un esperto di ricerca semantica. Rispondi SOLO con JSON." },
                { role: "user", content: prompt }
            ],
            response_format: { type: "json_object" }
        });

        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        monitor.logAIRequestWithCost('metadata', provider, model, inputTokens, outputTokens, 0, latency, false);

        const parsed = JSON.parse(response.choices[0].message.content || '{"queries":[]}');
        const queries = Array.isArray(parsed) ? parsed : (parsed.queries || parsed.list || []);

        return queries.slice(0, 5);
    } catch (e) {
        console.error('[identifyRelevantContext] ❌ Errore generazione query:', e);
        monitor.logAIRequestWithCost('metadata', 'openai', 'gpt-4o-mini', 0, 0, 0, Date.now() - startAI, true);
        return [
            `Eventi recenti ${snapshot.location?.macro || 'campagna'}`,
            `Dialoghi NPC ${snapshot.presentNpcs?.slice(0, 2).join(' ') || ''}`
        ].filter(q => q.trim().length > 10);
    }
}



export async function extractStructuredData(sessionId: string, narrativeText: string, castContext: string, memoryContext: string, partContext?: string, manifesto: string = ""): Promise<{ data: AnalystOutput, tokens: { input: number, output: number, inputChars: number, outputChars: number } }> {
    console.log(`[Analista] 📊 Estrazione dati strutturati (${narrativeText.length} chars)${partContext ? ` [${partContext}]` : ''}...`);

    // Inietto il contesto della parte se presente
    const effectiveText = partContext ? `[[${partContext}]]\n\n${narrativeText}` : narrativeText;
    const prompt = ANALYST_PROMPT(castContext, memoryContext, effectiveText);
    saveDebugFile(sessionId, 'analyst_prompt.txt', prompt);

    const startAI = Date.now();
    try {
        const { client, model, provider } = await getAnalystClient();

        const options: any = {
            model: model,
            messages: [
                { role: "system", content: `Sei un analista dati. Utilizza il seguente WORLD MANIFESTO come contesto globale della campagna:\n\n${manifesto}\n\nRispondi SOLO con JSON valido.` },
                { role: "user", content: prompt }
            ]

        };

        if (provider === 'openai') options.response_format = { type: "json_object" };
        else if (provider === 'ollama') options.format = 'json';

        const response: any = await client.chat.completions.create(options);
        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;
        monitor.logAIRequestWithCost('analyst', provider, model, inputTokens, outputTokens, cachedTokens, latency, false);

        // 🆕 Context Window Logging + Prompt Caching Stats
        const contextPct = ((inputTokens / ANALYST_CONTEXT_LIMIT) * 100).toFixed(1);
        const outputPct = ((outputTokens / ANALYST_OUTPUT_LIMIT) * 100).toFixed(1);
        const cachePct = inputTokens > 0 ? ((cachedTokens / inputTokens) * 100).toFixed(1) : '0';
        const contextWarning = inputTokens > ANALYST_CONTEXT_LIMIT * 0.8 ? '⚠️ NEAR LIMIT!' : '';
        const outputWarning = outputTokens > ANALYST_OUTPUT_LIMIT * 0.8 ? '⚠️ NEAR LIMIT!' : '';
        const cacheInfo = cachedTokens > 0 ? ` | 💾 Cached: ${cachedTokens.toLocaleString()} (${cachePct}%)` : '';
        console.log(`[Analista] 📊 Token Usage: ${inputTokens.toLocaleString()}/${ANALYST_CONTEXT_LIMIT.toLocaleString()} input (${contextPct}%) ${contextWarning} | ${outputTokens.toLocaleString()}/${ANALYST_OUTPUT_LIMIT.toLocaleString()} output (${outputPct}%) ${outputWarning}${cacheInfo}`);

        const content = response.choices[0].message.content || "{}";

        // 🆕 Save Token Usage
        const tokenUsage = {
            phase: 'analyst',
            input: inputTokens,
            output: outputTokens,
            total: (inputTokens + outputTokens),
            inputChars: prompt.length,
            outputChars: content.length
        };
        saveDebugFile(sessionId, 'analyst_response.txt', content);
        const parsed = safeJsonParse(content);

        // 🔍 DEBUG: Check artifacts in parsed JSON
        console.log(`[Analista] 🔍 DEBUG parsed.artifacts: ${JSON.stringify(parsed?.artifacts?.slice(0, 2) || 'undefined/null')}`);

        // Normalizations
        const validStatuses = ['ALIVE', 'DEAD', 'MISSING'] as const;
        const normalizedNpcUpdates = Array.isArray(parsed?.npc_dossier_updates)
            ? parsed.npc_dossier_updates.map((npc: any) => ({
                name: npc.name,
                description: npc.description,
                role: npc.role,
                status: validStatuses.includes(npc.status) ? npc.status as 'ALIVE' | 'DEAD' | 'MISSING' : undefined
            }))
                .filter((npc: any) => npc.description && npc.description.length > 5 && !npc.description.toLowerCase().includes('nessuna nota'))
            : [];

        const normalizedLocationUpdates = (Array.isArray(parsed?.location_updates) ? parsed.location_updates : []).map((loc: any) => {
            if (loc.macro && loc.micro) {
                const normalized = normalizeLocationNames(loc.macro, loc.micro);
                return { ...loc, macro: normalized.macro, micro: normalized.micro };
            }
            return loc;
        }).filter((loc: any) => loc.description && loc.description.trim().length > 10 && !loc.description.toLowerCase().includes("nessuna descrizione"));

        const normalizedTravelSequence = (Array.isArray(parsed?.travel_sequence) ? parsed.travel_sequence : []).map((step: any) => {
            if (step.macro && step.micro) {
                const normalized = normalizeLocationNames(step.macro, step.micro);
                return { ...step, macro: normalized.macro, micro: normalized.micro };
            }
            return step;
        });

        // Normalize Quests to structured objects
        const normalizedQuests = (Array.isArray(parsed?.quests) ? parsed.quests : []).map((q: any) => {
            if (typeof q === 'string') {
                return { title: q, description: '', status: 'OPEN' };
            }
            return {
                title: q.title,
                description: q.description || '',
                status: q.status || 'OPEN'
            };
        });

        return {
            data: {
                loot: normalizeLootList(parsed?.loot),
                loot_removed: normalizeLootList(parsed?.loot_removed),
                quests: normalizedQuests,
                monsters: Array.isArray(parsed?.monsters) ? parsed.monsters : [],
                npc_dossier_updates: normalizedNpcUpdates,
                location_updates: normalizedLocationUpdates,
                travel_sequence: normalizedTravelSequence,
                present_npcs: normalizeStringList(parsed?.present_npcs),
                log: normalizeStringList(parsed?.log),
                character_growth: Array.isArray(parsed?.character_growth) ? parsed.character_growth : [],
                npc_events: Array.isArray(parsed?.npc_events) ? parsed.npc_events : [],
                world_events: Array.isArray(parsed?.world_events) ? parsed.world_events : [],
                // 🆕 Faction System
                faction_updates: Array.isArray(parsed?.faction_updates) ? parsed.faction_updates : [],
                faction_affiliations: Array.isArray(parsed?.faction_affiliations) ? parsed.faction_affiliations : [],
                // 🆕 Party Alignment
                party_alignment_change: parsed?.party_alignment_change || undefined,
                // 🆕 Artifacts
                artifacts: Array.isArray(parsed?.artifacts) ? parsed.artifacts : [],
                // 🆕 Artifact Events
                artifact_events: Array.isArray(parsed?.artifact_events) ? parsed.artifact_events : []
            },
            tokens: { input: inputTokens, output: outputTokens, inputChars: prompt.length, outputChars: content.length }
        };

    } catch (e: any) {
        console.error('[Analista] ❌ Errore estrazione dati:', e.message);
        monitor.logAIRequestWithCost('analyst', 'openai', 'gpt-4o-mini', 0, 0, 0, Date.now() - startAI, true);
        return {
            data: {
                loot: [], loot_removed: [], quests: [], monsters: [],
                npc_dossier_updates: [], location_updates: [], travel_sequence: [], present_npcs: [],
                log: [], character_growth: [], npc_events: [], world_events: [],
                faction_updates: [], faction_affiliations: [], artifacts: [], artifact_events: []
            },
            tokens: { input: 0, output: 0, inputChars: 0, outputChars: 0 }
        };
    }
}

/**
 * PREPARAZIONE TESTO PULITO
 */
export function prepareCleanText(sessionId: string): string | undefined {
    const campaignId = getSessionCampaignId(sessionId);
    if (!campaignId) return undefined;

    const transcriptions = getSessionTranscript(sessionId);
    const notes = getSessionNotes(sessionId);
    const startTime = getSessionStartTime(sessionId) || 0;

    if (transcriptions.length === 0 && notes.length === 0) return undefined;

    const processed = processChronologicalSession(transcriptions, notes, startTime, campaignId);

    const cleanedSegments = processed.segments
        .map(s => ({
            ...s,
            text: filterWhisperHallucinations(s.text || '')
        }))
        .filter(s => s.text.length > 0);

    return cleanedSegments.map(s => `[${s.character}] ${s.text}`).join('\n\n');
}

/**
 * GENERATE SUMMARY (Main Function)
 */
export async function generateSummary(sessionId: string, tone: ToneKey = 'DM', narrativeText?: string, options: { skipAnalysis?: boolean, forceRegeneration?: boolean } = {}): Promise<SummaryResponse> {
    const startAI = Date.now();
    try {
        const { client, model, provider } = await getSummaryClient();
        console.log(`[Bardo] 📚 Generazione Riassunto per sessione ${sessionId} (Model: ${model}, Force: ${options.forceRegeneration})...`);

        // 1. CHECK CACHE (If not forcing regeneration)
        if (!options.forceRegeneration) {
            const cached = getSessionAIOutput(sessionId);
            if (cached) {
                // 🆕 Check Tone Compatibility
                const cachedTone = cached.summaryData.tone || 'DM'; // Default to DM if missing (backward compat)
                if (cachedTone !== tone) {
                    console.log(`[Bardo] ⚠️ Cache trovata ma con tono diverso (${cachedTone} vs ${tone}). Rigenero.`);
                } else {
                    console.log(`[Bardo] 💾 Trovata cache valida (generata il ${new Date(cached.lastGeneratedAt).toLocaleString()}). Uso dati salvati.`);
                    console.log(`[Bardo] 🔍 DEBUG Cache artifacts: ${JSON.stringify(cached.analystData.artifacts?.slice(0, 2) || 'undefined')}`);
                    return {
                        // Reconstruct SummaryResponse from cached data
                        summary: cached.summaryData.summary,
                        title: cached.summaryData.title,
                        tokens: cached.summaryData.tokens,
                        narrative: cached.summaryData.narrative,
                        narrativeBriefs: cached.summaryData.narrativeBriefs,
                        narrativeBrief: cached.summaryData.narrativeBrief,
                        log: cached.analystData.log,
                        character_growth: cached.analystData.character_growth,
                        npc_events: cached.analystData.npc_events,
                        world_events: cached.analystData.world_events,
                        loot: cached.analystData.loot,
                        loot_removed: cached.analystData.loot_removed,
                        quests: cached.analystData.quests,
                        monsters: cached.analystData.monsters,
                        npc_dossier_updates: cached.analystData.npc_dossier_updates,
                        location_updates: cached.analystData.location_updates,
                        travel_sequence: cached.analystData.travel_sequence,
                        present_npcs: cached.analystData.present_npcs,
                        // 🆕 Faction System
                        faction_updates: cached.analystData.faction_updates || [],
                        faction_affiliations: cached.analystData.faction_affiliations || [],
                        // 🆕 Party Alignment
                        party_alignment_change: cached.analystData.party_alignment_change,
                        // 🆕 Artifacts
                        artifacts: cached.analystData.artifacts || [],
                        // 🆕 Artifact Events
                        artifact_events: cached.analystData.artifact_events || []
                    };
                }
            }
        }

        const transcriptions = getSessionTranscript(sessionId);
        const notes = getSessionNotes(sessionId);
        const startTime = getSessionStartTime(sessionId) || 0;
        const campaignId = getSessionCampaignId(sessionId);

        if (transcriptions.length === 0 && notes.length === 0) return { summary: "Nessuna trascrizione trovata.", title: "Sessione Vuota", tokens: 0 };

        const userIds = new Set(transcriptions.map((t: any) => t.user_id));
        let castContext = "PERSONAGGI (Usa queste info per arricchire la narrazione):\n";

        // 0. PRE-FETCH DATA
        let partyFaction: any = null;
        if (campaignId) {
            partyFaction = factionRepository.getPartyFaction(campaignId);
        }

        // Collect player character names for Scout exclusion
        const playerCharacterNames: string[] = [];

        if (campaignId) {
            const campaign = getCampaignById(campaignId);
            if (campaign) castContext += `CAMPAGNA: ${campaign.name}\n`;
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
                    charInfo += ` [Allineamento: ${ethicalLabel} ${moralLabel} (M:${moralScore >= 0 ? '+' : ''}${moralScore}, E:${ethicalScore >= 0 ? '+' : ''}${ethicalScore})]`;
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
                castContext += `\n🎭 GRUPPO DI EROI (PARTY): **${partyFaction.name}** [ID: ${partyFaction.short_id || 'N/A'}] [Allineamento: ${pEthical} ${pMoral} (M:${pMoralScore >= 0 ? '+' : ''}${pMoralScore}, E:${pEthicalScore >= 0 ? '+' : ''}${pEthicalScore})]\n`;
            }
        }
        let fullDialogue: string;
        if (narrativeText && narrativeText.length > 100) {
            fullDialogue = narrativeText;
            console.log(`[Bardo] ✅ Usando testo narrativo pulito (${fullDialogue.length} chars)`);
        } else {
            const processed = processChronologicalSession(transcriptions, notes, startTime, campaignId || 0);
            fullDialogue = processed.linearText;
            console.log(`[Bardo] ⚠️ Fallback a trascrizioni standard (${fullDialogue.length} chars)`);
        }

        // --- SCOUT PHASE (CONTEXT INJECTION) ---
        let dynamicMemoryContext = "";
        if (campaignId) {
            console.log(`[Bardo] 🧠 Avvio Scout Phase...`);

            try {
                // 1. Eseguiamo lo Scout (con esclusione PG)
                console.log(`[Bardo] 🕵️ Scout esclude PG: ${playerCharacterNames.join(', ') || 'nessuno'}`);
                const { client, model, provider } = await getMetadataClient();
                const scoutResponse = await client.chat.completions.create({
                    model: model,
                    messages: [{ role: "user", content: SCOUT_PROMPT(fullDialogue, playerCharacterNames) }],
                    response_format: { type: "json_object" }
                });

                const entities = JSON.parse(scoutResponse.choices[0].message.content || '{"npcs":[], "locations":[], "quests":[], "factions":[], "artifacts":[]}');
                console.log(`[Bardo] 🕵️ Scout ha trovato: ${entities.npcs?.length || 0} NPC, ${entities.locations?.length || 0} Luoghi, ${entities.factions?.length || 0} Fazioni, ${entities.artifacts?.length || 0} Artefatti.`);

                // ============================================
                // 🆕 BATCH RECONCILIATION SYSTEM
                // Replaces individual reconcile calls with one batch
                // ============================================

                // Build entity index once (local, no API call)
                const entityIndex = buildEntityIndex(campaignId);

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
                // ============================================
                dynamicMemoryContext = "\n[[CONTESTO DINAMICO (ENTITÀ RILEVATE)]]\n";

                const scoutFactions: string[] = [];
                const foundNpcs = new Set<string>();
                const foundLocs = new Set<string>();
                const foundFactions = new Set<string>();
                const foundArtifacts = new Set<string>();

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
                                        let npcLine = `- **${npc.name}** [ID: ${npc.short_id || 'N/A'}] (${npc.role || 'Senza ruolo'}): ${(npc.description || 'Nessuna descrizione.').substring(0, 200)} [Status: ${npc.status || 'ALIVE'}]`;
                                        const npcMoralScore = (npc as any).moral_score ?? 0;
                                        const npcEthicalScore = (npc as any).ethical_score ?? 0;
                                        if (npcMoralScore !== 0 || npcEthicalScore !== 0 || (npc as any).alignment_moral || (npc as any).alignment_ethical) {
                                            npcLine += ` [Allineamento: ${(npc as any).alignment_ethical || 'NEUTRAL'} ${(npc as any).alignment_moral || 'NEUTRAL'} (M:${npcMoralScore >= 0 ? '+' : ''}${npcMoralScore}, E:${npcEthicalScore >= 0 ? '+' : ''}${npcEthicalScore})]`;
                                        }
                                        dynamicMemoryContext += npcLine + '\n';

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
                                        dynamicMemoryContext += `- **${locKey}** [ID: ${loc.short_id || 'N/A'}]: ${(loc.description || 'Nessuna descrizione.').substring(0, 200)}\n`;

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
                                        const { getArtifactByName } = await import('../db');
                                        const artifact = getArtifactByName(campaignId, entity.name);
                                        if (artifact) {
                                            let artifactInfo = `- **${artifact.name}** [ID: ${artifact.short_id || 'N/A'}]: ${(artifact.description || 'Nessuna descrizione.').substring(0, 200)}`;
                                            if (artifact.is_cursed) artifactInfo += ` [MALEDETTO]`;
                                            if (artifact.owner_name) artifactInfo += ` [Possessore: ${artifact.owner_name}]`;
                                            dynamicMemoryContext += artifactInfo + '\n';
                                        }
                                    } catch (e) { /* ignore */ }
                                }
                                break;
                        }
                    }
                }

                // Add section headers
                if (foundNpcs.size > 0) {
                    const npcSection = dynamicMemoryContext.split('\n').filter(l => l.includes('[Status:')).join('\n');
                    dynamicMemoryContext = dynamicMemoryContext.replace(npcSection, `\n👥 NPC PRESENTI (Dati Storici):\n${npcSection}`);
                }

                if (foundLocs.size > 0) {
                    dynamicMemoryContext += `\n🗺️ LUOGHI CITATI: ${foundLocs.size} luoghi riconosciuti\n`;
                }

                // Quest hydration (still uses legacy reconciler for now)
                if (entities.quests && Array.isArray(entities.quests) && entities.quests.length > 0) {
                    const foundQuests = new Set<string>();
                    dynamicMemoryContext += `\n⚔️ QUEST RILEVANTI:\n`;

                    for (const title of entities.quests) {
                        try {
                            const match = await reconcileQuestTitle(campaignId, title);
                            if (match && !foundQuests.has(match.canonicalTitle)) {
                                foundQuests.add(match.canonicalTitle);
                                const q = match.existingQuest;
                                let questInfo = `- **${q.title}** [ID: ${q.short_id || 'N/A'}]: ${q.description || 'Nessuna descrizione.'} [Status: ${q.status}]`;
                                if (q.type) questInfo += ` [${q.type}]`;
                                dynamicMemoryContext += questInfo + '\n';
                            }
                        } catch (e) {
                            console.error(`[Bardo] ⚠️ Errore riconciliazione Quest "${title}":`, e);
                        }
                    }

                    if (foundQuests.size === 0) {
                        dynamicMemoryContext += `- Nessuna quest nota corrispondente trovata.\n`;
                    }
                } else {
                    dynamicMemoryContext += `\n⚔️ NESSUNA QUEST MENZIONATA.\n`;
                }

                // Faction hydration (Party + Scout + from NPC/Location affiliations)
                if (partyFaction || scoutFactions.length > 0 || foundFactions.size > 0) {
                    dynamicMemoryContext += `\n⚔️ FAZIONI MENZIONATE:\n`;

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
                        let factionInfo = `- **${partyFaction.name}** [ID: ${partyFaction.short_id || 'N/A'}] (${partyFaction.type || 'ORGANIZATION'}): ${partyFaction.description || 'Nessuna descrizione.'}`;
                        factionInfo += ` [Allineamento: ${dmEthical} ${dmMoral} (M:${dmMoralScore >= 0 ? '+' : ''}${dmMoralScore}, E:${dmEthicalScore >= 0 ? '+' : ''}${dmEthicalScore})]`;
                        if (totalMembers > 0) factionInfo += ` [Membri: ${totalMembers}]`;
                        if (reputation && reputation !== 'NEUTRAL') factionInfo += ` [Reputazione: ${reputation}]`;
                        factionInfo += ` [FAZIONE PARTY]`;
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

                                let factionInfo = `- **${faction.name}** [ID: ${faction.short_id || 'N/A'}] (${faction.type || 'ORGANIZATION'}): ${faction.description || 'Nessuna descrizione.'}`;
                                const fMoralScore = faction.moral_score ?? 0;
                                const fEthicalScore = faction.ethical_score ?? 0;
                                if (fMoralScore !== 0 || fEthicalScore !== 0 || faction.alignment_moral || faction.alignment_ethical) {
                                    factionInfo += ` [Allineamento: ${faction.alignment_ethical || 'NEUTRAL'} ${faction.alignment_moral || 'NEUTRAL'} (M:${fMoralScore >= 0 ? '+' : ''}${fMoralScore}, E:${fEthicalScore >= 0 ? '+' : ''}${fEthicalScore})]`;
                                }
                                if (totalMembers > 0) factionInfo += ` [Membri: ${totalMembers}]`;
                                if (reputation && reputation !== 'NEUTRAL') factionInfo += ` [Reputazione: ${reputation}]`;
                                dynamicMemoryContext += factionInfo + '\n';
                            }
                        } catch (e) {
                            console.error(`[Bardo] ⚠️ Errore idratazione Fazione "${name}":`, e);
                        }
                    }
                }

                // Artifacts section header (already added inline)
                if (foundArtifacts.size > 0) {
                    dynamicMemoryContext = dynamicMemoryContext.replace(/^- \*\*.*\[MALEDETTO\].*$/m, `\n✨ ARTEFATTI MENZIONATI:\n$&`);
                }

                // LOG RIEPILOGATIVO CONTESTO
                console.log(`[Bardo] 📋 Riepilogo Contesto Analista:`);
                if (entities.npcs?.length) console.log(`  - NPCs: ${entities.npcs.join(', ')}`);
                if (entities.locations?.length) console.log(`  - Luoghi: ${entities.locations.join(', ')}`);
                if (entities.quests?.length) console.log(`  - Quest: ${entities.quests.join(', ')}`);
                if (entities.factions?.length) console.log(`  - Fazioni: ${entities.factions.join(', ')}`);
                if (entities.artifacts?.length) console.log(`  - Artefatti: ${entities.artifacts.join(', ')}`);

                // 🆕 DEBUG: Stampa tutto il contesto idratato
                console.log(`[Bardo] 📝 DETTAGLIO CONTESTO IDRATO:\n${dynamicMemoryContext}\n-----------------------------------`);

                // Fallback location corrente (snapshot already fetched above)
                let locationContext = snapshot.location_context || 'Sconosciuto';

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
                dynamicMemoryContext += `\n📍 LUOGO CORRENTE: ${locationContext}\n`;

            } catch (e) {
                console.error("[Bardo] ⚠️ Errore fase Scout, fallback a contesto base:", e);
                const snapshot = getCampaignSnapshot(campaignId);
                dynamicMemoryContext = `\n[[CONTESTO BASE (FALLBACK)]]\n📍 LUOGO: ${snapshot.location_context}\n⚔️ QUEST: ${snapshot.quest_context}\n`;
            }

            console.log(`[Bardo] 💧 Contesto Idrato (${dynamicMemoryContext.length} chars).`);
        }

        // 🆕 WORLD MANIFESTO GENERATION
        let worldManifesto = "";
        if (campaignId) {
            try {
                worldManifesto = await getOrCreateManifesto(campaignId);
            } catch (err) {
                console.error(`[Bardo] ⚠️ Failed to generate World Manifesto:`, err);
            }
        }

        // CALCOLO DINAMICO DEL LIMITE
        // Usa 300.000 (circa 75k token) per rimanere entro 128k totali con output e prompt
        const SAFE_CHAR_LIMIT = 300000;

        const parts = smartSplitTranscript(fullDialogue, SAFE_CHAR_LIMIT);

        if (parts.length > 1) {
            console.warn(`[Bardo] ⚠️ ATTENZIONE: La sessione è ENORME (${fullDialogue.length} chars). Attivo modalità episodica in ${parts.length} parti.`);
        } else {
            console.log(`[Bardo] ✅ Sessione nei limiti (${fullDialogue.length} chars). Elaborazione singola standard.`);
        }

        let finalNarrative = "";
        let accumulatedTokens = 0;

        // Token Accumulators for Technical Report
        const totalAnalystTokens = { input: 0, output: 0, inputChars: 0, outputChars: 0 };
        const totalWriterTokens = { input: 0, output: 0, inputChars: 0, outputChars: 0 };

        // Accumulatore dati (Analista + Scrittore)
        let aggregatedData: any = {
            title: "",
            narrativeBriefs: [] as string[], // Array di brief per ogni atto
            loot: [],
            loot_removed: [],
            quests: [],
            monsters: [],
            npc_dossier_updates: [],
            location_updates: [],
            travel_sequence: [],
            present_npcs: [],
            character_growth: [],
            npc_events: [],
            world_events: [],
            log: [],
            faction_updates: [],
            faction_affiliations: [],
            artifacts: [],
            artifact_events: []
        };

        // CICLO EPISODICO
        for (let i = 0; i < parts.length; i++) {
            const currentPart = parts[i];
            const isMultiPart = parts.length > 1;
            const actNumber = i + 1;

            console.log(`[Bardo] 🎬 Elaborazione Atto ${actNumber}/${parts.length}...`);

            // --- STEP A: ANALISTA (Per questa parte) ---
            let partialAnalystData: AnalystOutput = {
                loot: [], loot_removed: [], quests: [], monsters: [],
                npc_dossier_updates: [], location_updates: [], travel_sequence: [], present_npcs: [],
                log: [], character_growth: [], npc_events: [], world_events: [],
                faction_updates: [], faction_affiliations: [], artifacts: [], artifact_events: []
            };

            if (!options.skipAnalysis) {
                // Nota: Passiamo memoryContext globale e il contesto della parte
                const partHeader = isMultiPart ? `PARTE ${actNumber} DI ${parts.length}` : undefined;
                const analystResult = await extractStructuredData(sessionId, currentPart, castContext, dynamicMemoryContext, partHeader, worldManifesto);
                partialAnalystData = analystResult.data;

                // Aggregate Analyst Tokens
                totalAnalystTokens.input += analystResult.tokens.input;
                totalAnalystTokens.output += analystResult.tokens.output;
                totalAnalystTokens.inputChars += analystResult.tokens.inputChars;
                totalAnalystTokens.outputChars += analystResult.tokens.outputChars;
            } else if (i === 0) {
                // HYDRATION (Only on first pass to avoid duplication if we were to loop, though hydration should be global)
                console.log(`[Bardo] ⏩ Skipping Analysis. Hydrating from DB for session ${sessionId}...`);

                // Hydrate Loot
                const dbLoot = inventoryRepository.getSessionInventory(sessionId);
                partialAnalystData.loot = dbLoot.map((l: any) => ({
                    name: l.item_name,
                    quantity: l.quantity,
                    description: l.description
                }));

                // Hydrate Quests
                const dbQuests = questRepository.getSessionQuests(sessionId);
                partialAnalystData.quests = dbQuests.map((q: any) => ({
                    title: q.title,
                    description: q.description,
                    status: q.status
                }));

                // Hydrate Monsters
                const dbMonsters = bestiaryRepository.getSessionMonsters(sessionId);
                partialAnalystData.monsters = dbMonsters.map((m: any) => ({
                    name: m.name,
                    status: m.status,
                    count: m.count,
                    description: m.description,
                    abilities: safeJsonParse(m.abilities) || [],
                    weaknesses: safeJsonParse(m.weaknesses) || [],
                    resistances: safeJsonParse(m.resistances) || []
                }));

                // Hydrate NPCs
                const dbNpcs = npcRepository.getSessionEncounteredNPCs(sessionId);
                partialAnalystData.present_npcs = dbNpcs.map((n: any) => n.name);
                // Note: npc_dossier_updates is slightly different than encountered, it tracks CHANGES. 
                // We might not be able to fully reconstruct "updates" vs "state", but for narrative context, present_npcs is key.

                // Hydrate Location/Travel
                const travelLog = locationRepository.getSessionTravelLog(sessionId);
                partialAnalystData.travel_sequence = travelLog.map((t: any) => ({
                    macro: t.macro_location,
                    micro: t.micro_location,
                    reason: "Recorded in log"
                }));

                // If we have travel log, we can infer location updates roughly or leave empty as they are for atlas
                // partialAnalystData.location_updates = ... 

                // Hydrate Logs
                partialAnalystData.log = getSessionLog(sessionId);
            }

            // Merge Dati Analista
            if (partialAnalystData.loot) aggregatedData.loot.push(...partialAnalystData.loot);
            if (partialAnalystData.loot_removed) aggregatedData.loot_removed.push(...partialAnalystData.loot_removed);
            if (partialAnalystData.quests) aggregatedData.quests.push(...partialAnalystData.quests);
            if (partialAnalystData.monsters) aggregatedData.monsters.push(...partialAnalystData.monsters);
            if (partialAnalystData.npc_dossier_updates) aggregatedData.npc_dossier_updates.push(...partialAnalystData.npc_dossier_updates);
            if (partialAnalystData.location_updates) aggregatedData.location_updates.push(...partialAnalystData.location_updates);
            if (partialAnalystData.travel_sequence) aggregatedData.travel_sequence.push(...partialAnalystData.travel_sequence);
            if (partialAnalystData.travel_sequence) aggregatedData.travel_sequence.push(...partialAnalystData.travel_sequence);
            if (partialAnalystData.present_npcs) aggregatedData.present_npcs.push(...partialAnalystData.present_npcs);
            if (partialAnalystData.log) aggregatedData.log.push(...partialAnalystData.log);
            if (partialAnalystData.character_growth) aggregatedData.character_growth.push(...partialAnalystData.character_growth);
            if (partialAnalystData.npc_events) aggregatedData.npc_events.push(...partialAnalystData.npc_events);
            if (partialAnalystData.world_events) aggregatedData.world_events.push(...partialAnalystData.world_events);
            // 🆕 Faction System
            if (partialAnalystData.faction_updates) aggregatedData.faction_updates.push(...partialAnalystData.faction_updates);
            if (partialAnalystData.faction_affiliations) aggregatedData.faction_affiliations.push(...partialAnalystData.faction_affiliations);
            // 🆕 Party Alignment
            if (partialAnalystData.party_alignment_change) {
                aggregatedData.party_alignment_change = partialAnalystData.party_alignment_change;
            }
            // 🆕 Artifacts
            if (partialAnalystData.artifacts) aggregatedData.artifacts.push(...partialAnalystData.artifacts);
            // 🆕 Artifact Events
            if (partialAnalystData.artifact_events) aggregatedData.artifact_events.push(...partialAnalystData.artifact_events);

            // --- STEP B: SCRITTORE (Per questa parte) ---
            console.log(`[Bardo] ✍️ STEP 2: Scrittore - Atto ${actNumber} (${tone})...`);
            const partialAnalystJson = JSON.stringify(partialAnalystData, null, 2);

            let writerInject = "";
            if (isMultiPart) {
                writerInject = `\n\n[NOTA PER L'AI: Questa è la PARTE ${actNumber} di ${parts.length} di una sessione lunga. `;
                if (i > 0) writerInject += `Continua la narrazione coerentemente con la parte precedente.]`;
                else writerInject += `]`;
                writerInject += `\n\n`;
            }

            let reducePrompt = "";
            const narrativeContext = writerInject + `TRASCRIZIONE PARTE ${actNumber}:\n${currentPart}`;

            if (tone === 'DM') {
                reducePrompt = WRITER_DM_PROMPT(castContext, dynamicMemoryContext, partialAnalystJson)
                    + `\n\n${narrativeContext}`;
            } else {
                reducePrompt = WRITER_BARDO_PROMPT(tone, castContext, dynamicMemoryContext, partialAnalystJson)
                    + `\n\n${narrativeContext}`;
            }

            console.log(`[Bardo] 📏 Dimensione Prompt Scrittore: ${reducePrompt.length} chars`);

            // FILENAME FIX: Use standard name if single part, otherwise indexed
            const promptFileName = (!isMultiPart && i === 0) ? 'writer_prompt.txt' : `writer_prompt_act${actNumber}.txt`;
            saveDebugFile(sessionId, promptFileName, reducePrompt);

            const startAI = Date.now();
            const { client, model, provider } = await getSummaryClient();

            const writerSystemContent = worldManifesto
                ? `Sei un assistente D&D esperto. Usa il seguente WORLD MANIFESTO come contesto della campagna:\n\n${worldManifesto}\n\nRispondi SOLO con JSON valido.`
                : "Sei un assistente D&D esperto. Rispondi SOLO con JSON valido.";
            const summaryOptions: any = {
                model: model,
                messages: [
                    { role: "system", content: writerSystemContent },
                    { role: "user", content: reducePrompt }
                ]
            };

            if (provider === 'openai') {
                summaryOptions.response_format = { type: "json_object" };
                summaryOptions.max_completion_tokens = 16000;
            } else if (provider === 'ollama') {
                summaryOptions.format = 'json';
                summaryOptions.options = { num_ctx: 8192 };
            }

            const response: any = await withRetry(() => client.chat.completions.create(summaryOptions));
            const latency = Date.now() - startAI;
            const inputTokens = response.usage?.prompt_tokens || 0;
            const outputTokens = response.usage?.completion_tokens || 0;
            const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;
            accumulatedTokens += (response.usage?.total_tokens || 0);

            monitor.logAIRequestWithCost('summary', provider, model, inputTokens, outputTokens, cachedTokens, latency, false);

            // 🆕 Context Window Logging + Prompt Caching Stats (Per il singolo atto)
            const contextPct = ((inputTokens / SUMMARY_CONTEXT_LIMIT) * 100).toFixed(1);
            const cachePct = inputTokens > 0 ? ((cachedTokens / inputTokens) * 100).toFixed(1) : '0';
            const cacheInfo = cachedTokens > 0 ? ` | 💾 Cached: ${cachedTokens.toLocaleString()} (${cachePct}%)` : '';
            console.log(`[Bardo] 📊 Token Usage (Atto ${actNumber}): ${inputTokens.toLocaleString()}/${SUMMARY_CONTEXT_LIMIT.toLocaleString()} (${contextPct}%)${cacheInfo}`);

            const content = response.choices[0].message.content || "{}";
            const responseFileName = (!isMultiPart && i === 0) ? 'writer_response.txt' : `writer_response_act${actNumber}.txt`;
            saveDebugFile(sessionId, responseFileName, content);

            // Aggregate Writer Tokens
            totalWriterTokens.input += inputTokens;
            totalWriterTokens.output += outputTokens;
            totalWriterTokens.inputChars += reducePrompt.length;
            totalWriterTokens.outputChars += content.length;

            // Parsing output scrittore
            let parsed = safeJsonParse(content);
            if (!parsed) {
                console.error(`[Bardo] ⚠️ Errore parsing JSON Atto ${actNumber}`);
                parsed = { summary: content, title: "Errore Atto " + actNumber };
            }

            let partialNarrative = parsed.narrative || parsed.summary || "";
            if (!partialNarrative && Array.isArray(parsed.log) && parsed.log.length > 0) {
                partialNarrative = parsed.log.join('\n');
            }

            // Unione narrativa
            if (finalNarrative.length > 0) {
                finalNarrative += `\n\n`;
            }
            finalNarrative += partialNarrative;

            // Merge dati dallo scrittore
            // NOTE: character_growth, npc_events, world_events, log are now handled by Analyst
            // if (parsed.character_growth) aggregatedData.character_growth.push(...parsed.character_growth);
            // if (parsed.npc_events) aggregatedData.npc_events.push(...parsed.npc_events);
            // if (parsed.world_events) aggregatedData.world_events.push(...parsed.world_events);
            // if (parsed.log) aggregatedData.log.push(...parsed.log);

            // Titolo (Prendi il primo valido)
            if (!aggregatedData.title && parsed.title) aggregatedData.title = parsed.title;

            // NarrativeBrief (Accumula per ogni atto)
            if (parsed.narrativeBrief && parsed.narrativeBrief.length > 10) {
                aggregatedData.narrativeBriefs.push(parsed.narrativeBrief);
            } else if (partialNarrative && partialNarrative.length > 10) {
                // Fallback: usa i primi 1800 char del narrative parziale
                const fallbackBrief = partialNarrative.substring(0, 1800) + (partialNarrative.length > 1800 ? "..." : "");
                aggregatedData.narrativeBriefs.push(fallbackBrief);
            }

        } // FINE LOOP EPISODICO

        // 🆕 Save Aggregated Token Stats for Technical Report
        saveDebugFile(sessionId, 'analyst_tokens.json', JSON.stringify({
            phase: 'analyst',
            input: totalAnalystTokens.input,
            output: totalAnalystTokens.output,
            total: totalAnalystTokens.input + totalAnalystTokens.output,
            inputChars: totalAnalystTokens.inputChars,
            outputChars: totalAnalystTokens.outputChars
        }, null, 2));

        saveDebugFile(sessionId, 'writer_tokens.json', JSON.stringify({
            phase: 'writer',
            input: totalWriterTokens.input,
            output: totalWriterTokens.output,
            total: totalWriterTokens.input + totalWriterTokens.output,
            inputChars: totalWriterTokens.inputChars,
            outputChars: totalWriterTokens.outputChars
        }, null, 2));

        console.log(`[Bardo] 🏁 generateSummary completato (Totale ${parts.length} parti).`);

        // SAVE TO DB (Persistence)
        const summaryData = {
            summary: finalNarrative || "Errore generazione.",
            title: aggregatedData.title || `Sessione del ${new Date().toLocaleDateString()}`,
            tokens: accumulatedTokens,
            tone: tone, // 🆕 Save tone for cache validation
            narrative: finalNarrative || "Errore generazione.",
            narrativeBriefs: aggregatedData.narrativeBriefs.length > 0
                ? aggregatedData.narrativeBriefs
                : [finalNarrative.substring(0, 1800) + (finalNarrative.length > 1800 ? "..." : "")],
            narrativeBrief: aggregatedData.narrativeBriefs.length > 0
                ? aggregatedData.narrativeBriefs.map((b: string, i: number) =>
                    aggregatedData.narrativeBriefs.length > 1 ? `**Atto ${i + 1}**\n${b}` : b
                ).join('\n\n---\n\n')
                : (finalNarrative.substring(0, 1800) + (finalNarrative.length > 1800 ? "..." : ""))
        };

        saveSessionAIOutput(sessionId, aggregatedData, summaryData);
        console.log(`[Bardo] 💾 Salvati dati Analyst e Summary nel DB.`);

        return {
            // DALLO SCRITTORE (aggregato)
            summary: finalNarrative || "Errore generazione.",
            title: aggregatedData.title || `Sessione del ${new Date().toLocaleDateString()}`,
            tokens: accumulatedTokens,
            narrative: finalNarrative || "Errore generazione.",
            // Array di brief per ogni atto (per Discord multi-messaggio)
            narrativeBriefs: aggregatedData.narrativeBriefs.length > 0
                ? aggregatedData.narrativeBriefs
                : [finalNarrative.substring(0, 1800) + (finalNarrative.length > 1800 ? "..." : "")],
            // Brief concatenato (per mail body - compatibilità)
            narrativeBrief: aggregatedData.narrativeBriefs.length > 0
                ? aggregatedData.narrativeBriefs.map((b: string, i: number) =>
                    aggregatedData.narrativeBriefs.length > 1 ? `**Atto ${i + 1}**\n${b}` : b
                ).join('\n\n---\n\n')
                : (finalNarrative.substring(0, 1800) + (finalNarrative.length > 1800 ? "..." : "")),
            log: aggregatedData.log,
            character_growth: aggregatedData.character_growth,
            npc_events: aggregatedData.npc_events,
            world_events: aggregatedData.world_events,
            // DALL'ANALISTA (aggregato)
            loot: aggregatedData.loot,
            loot_removed: aggregatedData.loot_removed,
            quests: aggregatedData.quests,
            monsters: aggregatedData.monsters,
            npc_dossier_updates: aggregatedData.npc_dossier_updates,
            location_updates: aggregatedData.location_updates,
            travel_sequence: aggregatedData.travel_sequence,
            present_npcs: aggregatedData.present_npcs,
            // 🆕 Faction System
            faction_updates: aggregatedData.faction_updates,
            faction_affiliations: aggregatedData.faction_affiliations,
            // 🆕 Party Alignment
            party_alignment_change: aggregatedData.party_alignment_change,
            // 🆕 Artifacts
            artifacts: aggregatedData.artifacts,
            // 🆕 Artifact Events
            artifact_events: aggregatedData.artifact_events
        };
    } catch (err: any) {
        console.error("[Bardo] ❌ Errore finale:", err);
        monitor.logAIRequestWithCost('summary', 'openai', 'gpt-4o-mini', 0, 0, 0, Date.now() - startAI, true);
        throw err;
    }
}

/**
 * Regenerate NPC Notes/Biography
 */
/**
 * Regenerate NPC Notes/Biography
 * DEPRECATED: Use BioGenerator directly. Keeping for backward compat.
 */
export async function regenerateNpcNotes(campaignId: number, npcName: string, role: string, staticDesc: string): Promise<string> {
    const history = getNpcHistory(campaignId, npcName);
    return generateBio('NPC', { name: npcName, role, currentDesc: staticDesc }, history);
}

/**
 * Generate NPC Biography (Initial)
 */
/**
 * Generate NPC Biography (Initial)
 * DEPRECATED: Use BioGenerator.
 */
export async function generateNpcBiography(campaignId: number, npcName: string, role: string, staticDesc: string): Promise<string> {
    const history = getNpcHistory(campaignId, npcName);
    return generateBio('NPC', { name: npcName, role, currentDesc: staticDesc }, history);
}

/**
 * Generate Character Biography (Initial)
 */
/**
 * Generate Character Biography
 * DEPRECATED: Use BioGenerator.
 */
export async function generateCharacterBiography(campaignId: number, charName: string, charClass: string, charRace: string): Promise<string> {
    const history = getCharacterHistory(campaignId, charName);
    // Notare: BioGenerator per CHARACTER usa prompt conservativo (Agency).
    // Se vogliamo "una storia epica" per il comando $story, forse dovremmo usare un parametro diverso?
    // Ma l'unificazione dice "conservativo per PC".
    return generateBio('CHARACTER', { name: charName, currentDesc: "", class: charClass, race: charRace }, history);
}
