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
    // Add repositories for hydration
    inventoryRepository,
    questRepository,
    bestiaryRepository,
    npcRepository,
    locationRepository,
    worldRepository
} from '../db';
import * as fs from 'fs';
import * as path from 'path';

import {
    SUMMARY_MODEL,
    SUMMARY_PROVIDER,
    summaryClient,
    METADATA_MODEL,
    METADATA_PROVIDER,
    metadataClient,
    ANALYST_MODEL,
    ANALYST_PROVIDER,
    analystClient,
    MAP_MODEL,
    MAP_PROVIDER,
    mapClient,
    EMBEDDING_BATCH_SIZE,
    MAX_CHUNK_SIZE,
    CHUNK_OVERLAP
} from './config';

import {
    processInBatches,
    withRetry,
    safeJsonParse,
    normalizeStringList,
    normalizeLootList,
    smartSplitTranscript
} from './helpers';

import {
    SummaryResponse,
    ToneKey
} from './types';

import { searchKnowledge, ingestSessionComplete } from './rag'; // ingestSessionComplete handles RAG ingestion
import { filterWhisperHallucinations } from '../utils/filters/whisper';
import { monitor } from '../monitor';
import {
    MAP_PROMPT,
    CONTEXT_IDENTIFICATION_PROMPT,
    ANALYST_PROMPT,
    WRITER_DM_PROMPT,
    WRITER_BARDO_PROMPT,
    REGENERATE_NPC_NOTES_PROMPT,
    NPC_BIO_PROMPT,
    CHARACTER_BIO_PROMPT
} from './prompts';

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
        const response = await withRetry(() => mapClient.chat.completions.create({
            model: MAP_MODEL,
            messages: [
                { role: "system", content: mapPrompt },
                { role: "user", content: chunk }
            ],
        }));

        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        monitor.logAIRequestWithCost('map', MAP_PROVIDER, MAP_MODEL, inputTokens, outputTokens, 0, latency, false);

        return {
            text: response.choices[0].message.content || "",
            title: "",
            tokens: response.usage?.total_tokens || 0
        };
    } catch (err) {
        console.error(`[Map] ❌ Errore chunk ${index + 1}:`, err);
        monitor.logAIRequestWithCost('map', MAP_PROVIDER, MAP_MODEL, 0, 0, 0, Date.now() - startAI, true);
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
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [
                { role: "system", content: "Sei un esperto di ricerca semantica. Rispondi SOLO con JSON." },
                { role: "user", content: prompt }
            ],
            response_format: { type: "json_object" }
        });

        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        monitor.logAIRequestWithCost('metadata', METADATA_PROVIDER, METADATA_MODEL, inputTokens, outputTokens, 0, latency, false);

        const parsed = JSON.parse(response.choices[0].message.content || '{"queries":[]}');
        const queries = Array.isArray(parsed) ? parsed : (parsed.queries || parsed.list || []);

        return queries.slice(0, 5);
    } catch (e) {
        console.error('[identifyRelevantContext] ❌ Errore generazione query:', e);
        monitor.logAIRequestWithCost('metadata', METADATA_PROVIDER, METADATA_MODEL, 0, 0, 0, Date.now() - startAI, true);
        return [
            `Eventi recenti ${snapshot.location?.macro || 'campagna'}`,
            `Dialoghi NPC ${snapshot.presentNpcs?.slice(0, 2).join(' ') || ''}`
        ].filter(q => q.trim().length > 10);
    }
}

interface AnalystOutput {
    loot: Array<{ name: string; quantity?: number; description?: string }>;
    loot_removed: Array<{ name: string; quantity?: number; description?: string }>;
    quests: string[];
    monsters: Array<{ name: string; status: string; count?: string; description?: string; abilities?: string[]; weaknesses?: string[]; resistances?: string[] }>;
    npc_dossier_updates: Array<{ name: string; description: string; role?: string; status?: 'ALIVE' | 'DEAD' | 'MISSING' }>;
    location_updates: Array<{ macro: string; micro: string; description: string }>;
    travel_sequence: Array<{ macro: string; micro: string; reason?: string }>;
    present_npcs: string[];
}

export async function extractStructuredData(sessionId: string, narrativeText: string, castContext: string, memoryContext: string, partContext?: string): Promise<AnalystOutput> {
    console.log(`[Analista] 📊 Estrazione dati strutturati (${narrativeText.length} chars)${partContext ? ` [${partContext}]` : ''}...`);

    // Inietto il contesto della parte se presente
    const effectiveText = partContext ? `[[${partContext}]]\n\n${narrativeText}` : narrativeText;
    const prompt = ANALYST_PROMPT(castContext, memoryContext, effectiveText);
    saveDebugFile(sessionId, 'analyst_prompt.txt', prompt);

    const startAI = Date.now();
    try {
        const options: any = {
            model: SUMMARY_MODEL,
            messages: [
                { role: "system", content: "Sei un analista dati. Rispondi SOLO con JSON valido." },
                { role: "user", content: prompt }
            ]
        };

        if (SUMMARY_PROVIDER === 'openai') options.response_format = { type: "json_object" };
        else if (SUMMARY_PROVIDER === 'ollama') options.format = 'json';

        const response = await summaryClient.chat.completions.create(options);
        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        monitor.logAIRequestWithCost('analyst', SUMMARY_PROVIDER, SUMMARY_MODEL, inputTokens, outputTokens, 0, latency, false);

        // 🆕 Context Window Logging
        const CONTEXT_LIMIT = 128000;
        const OUTPUT_LIMIT = 16384;
        const totalTokens = inputTokens + outputTokens;
        const contextPct = ((inputTokens / CONTEXT_LIMIT) * 100).toFixed(1);
        const outputPct = ((outputTokens / OUTPUT_LIMIT) * 100).toFixed(1);
        const contextWarning = inputTokens > CONTEXT_LIMIT * 0.8 ? '⚠️ NEAR LIMIT!' : '';
        const outputWarning = outputTokens > OUTPUT_LIMIT * 0.8 ? '⚠️ NEAR LIMIT!' : '';
        console.log(`[Analista] 📊 Token Usage: ${inputTokens.toLocaleString()}/${CONTEXT_LIMIT.toLocaleString()} input (${contextPct}%) ${contextWarning} | ${outputTokens.toLocaleString()}/${OUTPUT_LIMIT.toLocaleString()} output (${outputPct}%) ${outputWarning}`);

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
        saveDebugFile(sessionId, 'analyst_tokens.json', JSON.stringify(tokenUsage, null, 2));
        saveDebugFile(sessionId, 'analyst_response.txt', content);
        const parsed = safeJsonParse(content);

        // Normalizations
        const validStatuses = ['ALIVE', 'DEAD', 'MISSING'] as const;
        const normalizedNpcUpdates = Array.isArray(parsed?.npc_dossier_updates)
            ? parsed.npc_dossier_updates.map((npc: any) => ({
                name: npc.name,
                description: npc.description,
                role: npc.role,
                status: validStatuses.includes(npc.status) ? npc.status as 'ALIVE' | 'DEAD' | 'MISSING' : undefined
            }))
            : [];

        const normalizedLocationUpdates = (Array.isArray(parsed?.location_updates) ? parsed.location_updates : []).map((loc: any) => {
            if (loc.macro && loc.micro) {
                const normalized = normalizeLocationNames(loc.macro, loc.micro);
                return { ...loc, macro: normalized.macro, micro: normalized.micro };
            }
            return loc;
        });

        const normalizedTravelSequence = (Array.isArray(parsed?.travel_sequence) ? parsed.travel_sequence : []).map((step: any) => {
            if (step.macro && step.micro) {
                const normalized = normalizeLocationNames(step.macro, step.micro);
                return { ...step, macro: normalized.macro, micro: normalized.micro };
            }
            return step;
        });

        return {
            loot: normalizeLootList(parsed?.loot),
            loot_removed: normalizeLootList(parsed?.loot_removed),
            quests: normalizeStringList(parsed?.quests),
            monsters: Array.isArray(parsed?.monsters) ? parsed.monsters : [],
            npc_dossier_updates: normalizedNpcUpdates,
            location_updates: normalizedLocationUpdates,
            travel_sequence: normalizedTravelSequence,
            present_npcs: normalizeStringList(parsed?.present_npcs)
        };

    } catch (e: any) {
        console.error('[Analista] ❌ Errore estrazione dati:', e.message);
        monitor.logAIRequestWithCost('analyst', ANALYST_PROVIDER, ANALYST_MODEL, 0, 0, 0, Date.now() - startAI, true);
        return { loot: [], loot_removed: [], quests: [], monsters: [], npc_dossier_updates: [], location_updates: [], travel_sequence: [], present_npcs: [] };
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
export async function generateSummary(sessionId: string, tone: ToneKey = 'DM', narrativeText?: string, options: { skipAnalysis?: boolean } = {}): Promise<SummaryResponse> {
    const startAI = Date.now();
    try {
        console.log(`[Bardo] 📚 Generazione Riassunto per sessione ${sessionId} (Model: ${SUMMARY_MODEL})...`);

        const transcriptions = getSessionTranscript(sessionId);
        const notes = getSessionNotes(sessionId);
        const startTime = getSessionStartTime(sessionId) || 0;
        const campaignId = getSessionCampaignId(sessionId);

        if (transcriptions.length === 0 && notes.length === 0) return { summary: "Nessuna trascrizione trovata.", title: "Sessione Vuota", tokens: 0 };

        const userIds = new Set(transcriptions.map((t: any) => t.user_id));
        let castContext = "PERSONAGGI (Usa queste info per arricchire la narrazione):\n";

        if (campaignId) {
            const campaign = getCampaignById(campaignId);
            if (campaign) castContext += `CAMPAGNA: ${campaign.name}\n`;
            userIds.forEach(uid => {
                const p = getUserProfile(uid, campaignId);
                if (p.character_name) {
                    let charInfo = `- **${p.character_name}**`;
                    const details = [];
                    if (p.race) details.push(p.race);
                    if (p.class) details.push(p.class);
                    if (details.length > 0) charInfo += ` (${details.join(' ')})`;
                    if (p.description) charInfo += `: "${p.description}"`;
                    castContext += charInfo + "\n";
                }
            });
        }

        // --- TOTAL RECALL (CONTEXT INJECTION HYBRID) ---
        let memoryContext = "";
        if (campaignId) {
            console.log(`[Bardo] 🧠 Avvio Total Recall Ibrido...`);
            const snapshot = getCampaignSnapshot(campaignId);

            const locationQuery = snapshot.location ? `${snapshot.location.macro || ''} ${snapshot.location.micro || ''}`.trim() : "";
            const staticQueries = locationQuery ? [searchKnowledge(campaignId, `Info su luogo: ${locationQuery}`, 2)] : [];

            const rawTranscript = transcriptions.map((t: any) => t.transcription_text).join('\n');
            const textForAnalysis = (narrativeText && narrativeText.length > 100) ? narrativeText : rawTranscript;

            const dynamicQueries = await identifyRelevantContext(campaignId, textForAnalysis, snapshot, narrativeText);
            const dynamicPromises = dynamicQueries.map(q => searchKnowledge(campaignId, q, 3));

            const [staticResults, ...dynamicResults] = await Promise.all([Promise.all(staticQueries), ...dynamicPromises]);

            memoryContext = `\n[[MEMORIA DEL MONDO E CONTESTO]]\n`;
            memoryContext += `📍 LUOGO: ${snapshot.location_context || 'Sconosciuto'}\n`;
            memoryContext += `⚔️ QUEST ATTIVE: ${snapshot.quest_context || 'Nessuna'}\n`;

            const existingNpcs = listNpcs(campaignId);
            if (existingNpcs.length > 0) {
                memoryContext += `\n👥 NPC GIÀ NOTI (USA QUESTI NOMI!):\n`;
                existingNpcs.forEach((npc: any) => {
                    memoryContext += `- "${npc.name}" (${npc.role || '?'})\n`;
                });
            }

            const existingLocations = listAtlasEntries(campaignId, 50);
            if (existingLocations.length > 0) {
                memoryContext += `\n🗺️ LUOGHI GIÀ NOTI:\n`;
                existingLocations.forEach((loc: any) => {
                    memoryContext += `- "${loc.macro_location} - ${loc.micro_location}"\n`;
                });
            }

            const allMemories = [...staticResults.flat(), ...dynamicResults.flat()];
            const uniqueMemories = Array.from(new Set(allMemories));
            if (uniqueMemories.length > 0) {
                memoryContext += `\n🔍 RICORDI RILEVANTI:\n${uniqueMemories.map(m => `- ${m}`).join('\n')}\n`;
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
            log: []
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
                npc_dossier_updates: [], location_updates: [], travel_sequence: [], present_npcs: []
            };

            if (!options.skipAnalysis) {
                // Nota: Passiamo memoryContext globale e il contesto della parte
                const partHeader = isMultiPart ? `PARTE ${actNumber} DI ${parts.length}` : undefined;
                partialAnalystData = await extractStructuredData(sessionId, currentPart, castContext, memoryContext, partHeader);
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
                partialAnalystData.quests = dbQuests.map((q: any) => q.title);

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
            }

            // Merge Dati Analista
            if (partialAnalystData.loot) aggregatedData.loot.push(...partialAnalystData.loot);
            if (partialAnalystData.loot_removed) aggregatedData.loot_removed.push(...partialAnalystData.loot_removed);
            if (partialAnalystData.quests) aggregatedData.quests.push(...partialAnalystData.quests);
            if (partialAnalystData.monsters) aggregatedData.monsters.push(...partialAnalystData.monsters);
            if (partialAnalystData.npc_dossier_updates) aggregatedData.npc_dossier_updates.push(...partialAnalystData.npc_dossier_updates);
            if (partialAnalystData.location_updates) aggregatedData.location_updates.push(...partialAnalystData.location_updates);
            if (partialAnalystData.travel_sequence) aggregatedData.travel_sequence.push(...partialAnalystData.travel_sequence);
            if (partialAnalystData.present_npcs) aggregatedData.present_npcs.push(...partialAnalystData.present_npcs);

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
                reducePrompt = WRITER_DM_PROMPT(castContext, memoryContext, partialAnalystJson)
                    + `\n\n${narrativeContext}`;
            } else {
                reducePrompt = WRITER_BARDO_PROMPT(tone, castContext, memoryContext, partialAnalystJson)
                    + `\n\n${narrativeContext}`;
            }

            console.log(`[Bardo] 📏 Dimensione Prompt Scrittore: ${reducePrompt.length} chars`);
            saveDebugFile(sessionId, `writer_prompt_act${actNumber}.txt`, reducePrompt);

            const startAI = Date.now();
            const summaryOptions: any = {
                model: SUMMARY_MODEL,
                messages: [
                    { role: "system", content: "Sei un assistente D&D esperto. Rispondi SOLO con JSON valido." },
                    { role: "user", content: reducePrompt }
                ]
            };

            if (SUMMARY_PROVIDER === 'openai') {
                summaryOptions.response_format = { type: "json_object" };
                summaryOptions.max_completion_tokens = 16000;
            } else if (SUMMARY_PROVIDER === 'ollama') {
                summaryOptions.format = 'json';
                summaryOptions.options = { num_ctx: 8192 };
            }

            const response = await withRetry(() => summaryClient.chat.completions.create(summaryOptions));
            const latency = Date.now() - startAI;
            const inputTokens = response.usage?.prompt_tokens || 0;
            const outputTokens = response.usage?.completion_tokens || 0;
            const cachedTokens = (response.usage as any)?.prompt_tokens_details?.cached_tokens || 0;
            accumulatedTokens += (response.usage?.total_tokens || 0);

            monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, inputTokens, outputTokens, cachedTokens, latency, false);

            // 🆕 Context Window Logging (Per il singolo atto)
            const CONTEXT_LIMIT = 128000;
            const OUTPUT_LIMIT = 16384;
            const contextPct = ((inputTokens / CONTEXT_LIMIT) * 100).toFixed(1);
            console.log(`[Bardo] 📊 Token Usage (Atto ${actNumber}): ${inputTokens.toLocaleString()}/${CONTEXT_LIMIT.toLocaleString()} (${contextPct}%)`);

            const content = response.choices[0].message.content || "{}";
            saveDebugFile(sessionId, `writer_response_act${actNumber}.txt`, content);

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
            if (parsed.character_growth) aggregatedData.character_growth.push(...parsed.character_growth);
            if (parsed.npc_events) aggregatedData.npc_events.push(...parsed.npc_events);
            if (parsed.world_events) aggregatedData.world_events.push(...parsed.world_events);
            if (parsed.log) aggregatedData.log.push(...parsed.log);

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

        console.log(`[Bardo] 🏁 generateSummary completato (Totale ${parts.length} parti).`);

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
            present_npcs: aggregatedData.present_npcs
        };
    } catch (err: any) {
        console.error("[Bardo] ❌ Errore finale:", err);
        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, 0, 0, 0, Date.now() - startAI, true);
        throw err;
    }
}

/**
 * Regenerate NPC Notes/Biography
 */
export async function regenerateNpcNotes(campaignId: number, npcName: string, role: string, staticDesc: string): Promise<string> {
    const history = getNpcHistory(campaignId, npcName);
    const historyText = history.length > 0 ? history.map((h: any) => `[${h.event_type}] ${h.description}`).join('\n') : "Nessun evento storico specifico registrato.";
    const complexityLevel = history.length > 5 ? "DETTAGLIATO" : "CONCISO";

    const prompt = REGENERATE_NPC_NOTES_PROMPT(npcName, role, staticDesc, historyText, complexityLevel);

    const startAI = Date.now();
    try {
        const response = await metadataClient.chat.completions.create({
            model: SUMMARY_MODEL, // Use SUMMARY_MODEL for better generation
            messages: [{ role: "user", content: prompt }]
        });
        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, inputTokens, outputTokens, 0, latency, false);

        return response.choices[0].message.content || staticDesc;
    } catch (e) {
        console.error(`[NpcNotes] Errore rigenerazione ${npcName}:`, e);
        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, 0, 0, 0, Date.now() - startAI, true);
        return staticDesc;
    }
}

/**
 * Generate NPC Biography (Initial)
 */
export async function generateNpcBiography(campaignId: number, npcName: string, role: string, staticDesc: string): Promise<string> {
    const history = getNpcHistory(campaignId, npcName);
    const historyText = history.length > 0 ? history.map((h: any) => `[${h.event_type}] ${h.description}`).join('\n') : "Nessun evento storico registrato.";
    const prompt = NPC_BIO_PROMPT(npcName, role, staticDesc, historyText);

    const startAI = Date.now();
    try {
        const response = await summaryClient.chat.completions.create({
            model: SUMMARY_MODEL,
            messages: [{ role: "user", content: prompt }]
        });
        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, inputTokens, outputTokens, 0, latency, false);

        return response.choices[0].message.content || staticDesc;
    } catch (e) {
        console.error(`[NpcBio] Errore generazione bio ${npcName}:`, e);
        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, 0, 0, 0, Date.now() - startAI, true);
        return staticDesc;
    }
}

/**
 * Generate Character Biography (Initial)
 */
export async function generateCharacterBiography(campaignId: number, charName: string, charClass: string, charRace: string): Promise<string> {
    const history = getCharacterHistory(campaignId, charName);
    if (history.length === 0) return `Non c'è ancora abbastanza storia scritta su ${charName}.`;

    const eventsText = history.map((h: any) => `[${h.event_type}] ${h.description}`).join('\n');
    const prompt = CHARACTER_BIO_PROMPT(charName, charRace, charClass, eventsText);

    const startAI = Date.now();
    try {
        const response = await summaryClient.chat.completions.create({
            model: SUMMARY_MODEL,
            messages: [{ role: "user", content: prompt }]
        });
        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, inputTokens, outputTokens, 0, latency, false);

        return response.choices[0].message.content || "";
    } catch (e) {
        console.error(`[CharBio] Errore generazione ${charName}:`, e);
        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, 0, 0, 0, Date.now() - startAI, true);
        return "";
    }
}
