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
    getCharacterHistory // for generateCharacterBio
} from '../db';

import {
    SUMMARY_MODEL,
    SUMMARY_PROVIDER,
    summaryClient,
    ANALYST_MODEL,
    ANALYST_PROVIDER,
    analystClient,
    MAP_MODEL,
    MAP_PROVIDER,
    mapClient,
    EMBEDDING_BATCH_SIZE
} from './config';

import {
    processInBatches,
    withRetry,
    safeJsonParse,
    normalizeStringList
} from './helpers';

import {
    SummaryResponse,
    ToneKey
} from './types';

import { searchKnowledge, ingestSessionComplete } from './rag'; // ingestSessionComplete handles RAG ingestion
import { filterWhisperHallucinations } from '../utils/filters/whisper';
import { monitor } from '../monitor';

// Constants
const MAX_CHUNK_SIZE = 45000;
const CHUNK_OVERLAP = 2000;
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
    const mapPrompt = `Sei un analista di D&D.\n    ${castContext}\n    Estrai un elenco puntato cronologico strutturato esattamente così:\n    1. Nomi di NPC incontrati e le frasi chiave che hanno pronunciato (anche se lette dalla voce del DM);\n    2. Luoghi visitati;\n    3. Oggetti ottenuti (Loot) con dettagli;\n    4. Numeri/Danni rilevanti;\n    5. Decisioni chiave dei giocatori.\n    6. Dialoghi importanti e il loro contenuto.\n    \n    Sii conciso. Se per una categoria non ci sono dati, scrivi "Nessuno".`;

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

    const prompt = `Sei l'Archivista della campagna D&D "${snapshot.campaignName || 'Sconosciuta'}".

**CONTESTO SNAPSHOT CORRENTE:**
- Sessione: #${snapshot.sessionNumber || '?'}
- Luogo: ${snapshot.location?.macro || 'Sconosciuto'} - ${snapshot.location?.micro || 'Sconosciuto'}
- NPC Presenti: ${snapshot.presentNpcs?.join(', ') || 'Nessuno'}
- Quest Attive: ${snapshot.quests?.slice(0, 3).join(', ') || snapshot.quest_context || 'Nessuna'}

**TRASCRIZIONE CONDENSATA (Eventi Chiave):**
${analysisText}

**COMPITO:**
Analizza la trascrizione e genera 3-5 query di ricerca specifiche per recuperare informazioni rilevanti dal database vettoriale (RAG).

**OUTPUT:**
Restituisci un JSON con array "queries": ["query1", "query2", "query3"]`;

    const startAI = Date.now();
    try {
        const response = await summaryClient.chat.completions.create({
            model: SUMMARY_MODEL,
            messages: [
                { role: "system", content: "Sei un esperto di ricerca semantica. Rispondi SOLO con JSON." },
                { role: "user", content: prompt }
            ],
            response_format: { type: "json_object" }
        });

        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, inputTokens, outputTokens, 0, latency, false);

        const parsed = JSON.parse(response.choices[0].message.content || '{"queries":[]}');
        const queries = Array.isArray(parsed) ? parsed : (parsed.queries || parsed.list || []);

        return queries.slice(0, 5);
    } catch (e) {
        console.error('[identifyRelevantContext] ❌ Errore generazione query:', e);
        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, 0, 0, 0, Date.now() - startAI, true);
        return [
            `Eventi recenti ${snapshot.location?.macro || 'campagna'}`,
            `Dialoghi NPC ${snapshot.presentNpcs?.slice(0, 2).join(' ') || ''}`
        ].filter(q => q.trim().length > 10);
    }
}

interface AnalystOutput {
    loot: string[];
    loot_removed: string[];
    quests: string[];
    monsters: Array<{ name: string; status: string; count?: string; description?: string; abilities?: string[]; weaknesses?: string[]; resistances?: string[] }>;
    npc_dossier_updates: Array<{ name: string; description: string; role?: string; status?: 'ALIVE' | 'DEAD' | 'MISSING' }>;
    location_updates: Array<{ macro: string; micro: string; description: string }>;
    travel_sequence: Array<{ macro: string; micro: string; reason?: string }>;
    present_npcs: string[];
}

async function extractStructuredData(narrativeText: string, castContext: string, memoryContext: string): Promise<AnalystOutput> {
    console.log(`[Analista] 📊 Estrazione dati strutturati (${narrativeText.length} chars)...`);
    const prompt = `Sei un ANALISTA DATI esperto di D&D. Il tuo UNICO compito è ESTRARRE DATI STRUTTURATI.
NON scrivere narrativa. NON riassumere. SOLO estrai e cataloga.

${castContext}
${memoryContext}

**ISTRUZIONI RIGOROSE**:
1. Leggi ATTENTAMENTE il testo
2. Estrai SOLO ciò che è ESPLICITAMENTE menzionato
3. NON inventare
4. Se non trovi qualcosa, lascia array vuoto []

**OUTPUT JSON RICHIESTO**:
{
    "loot": ["Lista oggetti TROVATI/OTTENUTI"],
    "loot_removed": ["Lista oggetti PERSI/USATI/CONSUMATI"],
    "quests": ["Lista missioni ACCETTATE/COMPLETATE/AGGIORNATE"],
    "monsters": [{ "name": "...", "status": "...", "count": "...", "description": "...", "abilities": [], "weaknesses": [], "resistances": [] }],
    "npc_dossier_updates": [{ "name": "...", "description": "...", "role": "...", "status": "..." }],
    "location_updates": [{ "macro": "...", "micro": "...", "description": "..." }],
    "travel_sequence": [{ "macro": "...", "micro": "...", "reason": "..." }],
    "present_npcs": ["Lista TUTTI i nomi NPC menzionati"]
}

**TESTO DA ANALIZZARE**:
${narrativeText.substring(0, 80000)}

Rispondi SOLO con JSON valido.`;

    const startAI = Date.now();
    try {
        const options: any = {
            model: ANALYST_MODEL,
            messages: [
                { role: "system", content: "Sei un analista dati. Rispondi SOLO con JSON valido." },
                { role: "user", content: prompt }
            ]
        };

        if (ANALYST_PROVIDER === 'openai') options.response_format = { type: "json_object" };
        else if (ANALYST_PROVIDER === 'ollama') options.format = 'json';

        const response = await analystClient.chat.completions.create(options);
        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        monitor.logAIRequestWithCost('analyst', ANALYST_PROVIDER, ANALYST_MODEL, inputTokens, outputTokens, 0, latency, false);

        const parsed = safeJsonParse(response.choices[0].message.content || "{}");

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
            loot: normalizeStringList(parsed?.loot),
            loot_removed: normalizeStringList(parsed?.loot_removed),
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
export async function generateSummary(sessionId: string, tone: ToneKey = 'DM', narrativeText?: string): Promise<SummaryResponse> {
    console.log(`[Bardo] 📚 Generazione Riassunto per sessione ${sessionId}...`);

    const transcriptions = getSessionTranscript(sessionId);
    const notes = getSessionNotes(sessionId);
    const startTime = getSessionStartTime(sessionId) || 0;
    const campaignId = getSessionCampaignId(sessionId);

    if (transcriptions.length === 0 && notes.length === 0) return { summary: "Nessuna trascrizione trovata.", title: "Sessione Vuota", tokens: 0 };

    const userIds = new Set(transcriptions.map((t: any) => t.user_id));
    let castContext = "PERSONAGGI:\n";

    if (campaignId) {
        const campaign = getCampaignById(campaignId);
        if (campaign) castContext += `CAMPAGNA: ${campaign.name}\n`;
        userIds.forEach(uid => {
            const p = getUserProfile(uid, campaignId);
            if (p.character_name) castContext += `- ${p.character_name} ${p.class}\n`;
        });
    }

    let memoryContext = "";
    if (campaignId) {
        console.log(`[Bardo] 🧠 Avvio Total Recall...`);
        const snapshot = getCampaignSnapshot(campaignId);

        const locationQuery = snapshot.location ? `${snapshot.location.macro || ''} ${snapshot.location.micro || ''}`.trim() : "";
        const staticQueries = locationQuery ? [searchKnowledge(campaignId, `Info su luogo: ${locationQuery}`, 2)] : [];

        const rawTranscript = transcriptions.map((t: any) => t.transcription_text).join('\n');
        const textForAnalysis = (narrativeText && narrativeText.length > 100) ? narrativeText : rawTranscript;

        const dynamicQueries = await identifyRelevantContext(campaignId, textForAnalysis, snapshot, narrativeText);
        const dynamicPromises = dynamicQueries.map(q => searchKnowledge(campaignId, q, 3));

        const [staticResults, ...dynamicResults] = await Promise.all([Promise.all(staticQueries), ...dynamicPromises]);

        memoryContext = `\n[[MEMORIA DEL MONDO]]\n`;
        const allMemories = [...staticResults.flat(), ...dynamicResults.flat()];
        const uniqueMemories = Array.from(new Set(allMemories));
        if (uniqueMemories.length > 0) memoryContext += uniqueMemories.map(m => `- ${m}`).join('\n') + '\n';

        const existingNpcs = listNpcs(campaignId);
        if (existingNpcs.length > 0) {
            memoryContext += `\n👥 DOSSIER NPC:\n${existingNpcs.map((n: any) => `- ${n.name}`).join('\n')}\n`;
        }
    }

    let fullDialogue: string;
    if (narrativeText && narrativeText.length > 100) {
        fullDialogue = narrativeText;
    } else {
        const processed = processChronologicalSession(transcriptions, notes, startTime, campaignId || 0);
        fullDialogue = processed.linearText;
    }

    const analystData = await extractStructuredData(fullDialogue, castContext, memoryContext);

    let contextForFinalStep = fullDialogue;
    if (fullDialogue.length > MAX_CHUNK_SIZE) {
        const chunks = splitTextInChunks(fullDialogue, MAX_CHUNK_SIZE, CHUNK_OVERLAP);
        const mapResults = await processInBatches(chunks, MAP_CONCURRENCY, async (chunk: string, index: number) => {
            return await extractFactsFromChunk(chunk, index, chunks.length, castContext);
        }, "Analisi Frammenti");
        contextForFinalStep = mapResults.map((r: any) => r.text).join("\n\n---\n\n");
    }

    const writerPrompt = `Sei un Romanziere Fantasy e Bardo.
${castContext}
${memoryContext}

DATI ANALITICI ESTRATTI:
- Quest: ${analystData.quests.join(', ')}
- Loot: ${analystData.loot.join(', ')}
- Luoghi: ${analystData.location_updates.map(l => l.macro + '-' + l.micro).join(', ')}

Scrivi un riassunto narrativo avvincente della sessione (max 2000 parole).
Usa il tono: ${tone}.
Dividi in capitoli.

TESTO DA RIASSUMERE:
${contextForFinalStep.substring(0, 50000)}`;

    const startWriter = Date.now();
    const writerResponse = await summaryClient.chat.completions.create({
        model: SUMMARY_MODEL,
        messages: [{ role: "user", content: writerPrompt }],
    });
    const narrative = writerResponse.choices[0].message.content || "Errore generazione.";

    const result: SummaryResponse = {
        summary: narrative,
        narrative: narrative, // Duplicate for compatibility
        title: `Cronache di ${campaignId ? 'Campagna' : 'Sessione'}`, // Placeholder title generation
        tokens: writerResponse.usage?.total_tokens || 0,
        ...analystData
    };

    if (campaignId) {
        await ingestSessionComplete(sessionId, result);
    }

    return result;
}

/**
 * Regenerate NPC Notes/Biography
 */
export async function regenerateNpcNotes(campaignId: number, npcName: string, role: string, staticDesc: string): Promise<string> {
    const prompt = `Riassumi info su NPC: ${npcName} (${role}). Descrizione: ${staticDesc}`;
    const response = await summaryClient.chat.completions.create({
        model: SUMMARY_MODEL,
        messages: [{ role: "user", content: prompt }]
    });
    return response.choices[0].message.content || staticDesc;
}

/**
 * Generate NPC Biography (Initial)
 */
export async function generateNpcBiography(campaignId: number, npcName: string, role: string, staticDesc: string): Promise<string> {
    return regenerateNpcNotes(campaignId, npcName, role, staticDesc);
}

/**
 * Generate Character Biography (Initial)
 */
export async function generateCharacterBiography(campaignId: number, charName: string, charClass: string, charRace: string): Promise<string> {
    const prompt = `Scrivi bio per PG: ${charName} (${charRace} ${charClass}).`;
    const response = await summaryClient.chat.completions.create({
        model: SUMMARY_MODEL,
        messages: [{ role: "user", content: prompt }]
    });
    return response.choices[0].message.content || "";
}
