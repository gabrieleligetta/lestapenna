import OpenAI from 'openai';
import {
    getSessionTranscript,
    getUserProfile,
    getSessionErrors,
    getSessionStartTime,
    getSessionCampaignId,
    getCampaignById,
    getCampaigns,
    getCampaignCharacters,
    insertKnowledgeFragment,
    getKnowledgeFragments,
    deleteSessionKnowledge,
    KnowledgeFragment,
    getSessionNotes,
    LocationState,
    getCampaignLocationById,
    getAtlasEntry,
    findNpcDossierByName,
    listNpcs,
    getCharacterHistory,
    getNpcHistory,
    getCampaignSnapshot
} from './db';
import { monitor } from './monitor';

// --- CONFIGURAZIONE TONI ---
export const TONES = {
    EPICO: "Sei un cantastorie epico. Usa un linguaggio epico, solenne, enfatizza l'eroismo e il destino.",
    DIVERTENTE: "Sei un bardo ubriaco e sarcastico. Prendi in giro i fallimenti dei personaggi.",
    OSCURO: "Sei un cronista di un mondo Lovecraftiano. Tono cupo e disperato.",
    CONCISO: "Sei un segretario efficiente. solo fatti narrazione in terza persona.",
    DM: "Sei un assistente per il Dungeon Master. Punti salienti, loot e NPC."
};

export type ToneKey = keyof typeof TONES;

// ============================================
// HELPER: SAFE JSON PARSING & NORMALIZATION
// ============================================

/**
 * Tenta di parsare una stringa JSON sporca (con markdown, commenti, virgole extra).
 * Restituisce null se fallisce.
 */
function safeJsonParse(input: string): any {
    if (!input) return null;
    
    // 1. Pulizia Markdown e spazi
    let cleaned = input.replace(/```json/gi, '').replace(/```/g, '').trim();

    // 2. Estrazione chirurgica del JSON (dal primo '{' all'ultimo '}')
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');

    if (firstBrace !== -1 && lastBrace !== -1) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    } else {
        // Nessuna struttura JSON trovata
        return null;
    }

    // 3. Parsing con tentativi di riparazione
    try {
        return JSON.parse(cleaned);
    } catch (e) {
        // Fallback per errori comuni di Llama (trailing commas, commenti)
        try {
            // Rimuovi commenti stile JS (// ...)
            let fixed = cleaned.replace(/\s*\/\/.*$/gm, ''); 
            // Rimuovi virgole appese (trailing commas) es: "a": 1, } -> "a": 1 }
            fixed = fixed.replace(/,\s*([\]}])/g, '$1');
            
            return JSON.parse(fixed);
        } catch (e2) {
            console.warn("[SafeParse] Fallito parsing JSON anche dopo pulizia.");
            return null;
        }
    }
}

/**
 * Normalizza una lista mista (stringhe/oggetti) in una lista di sole stringhe.
 * Utile per correggere output di LLM che restituiscono oggetti invece di stringhe.
 */
function normalizeStringList(list: any[]): string[] {
    if (!Array.isArray(list)) return [];

    return list.map(item => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item !== null) {
            // Cerca chiavi comuni dove potrebbe essere nascosto il valore
            return item.name || item.nome || item.item || item.description || item.value || JSON.stringify(item);
        }
        return String(item);
    }).filter(s => s && s.trim().length > 0);
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Determina il provider per una fase specifica
 * @param phaseEnvVar Nome variabile env specifica (es: METADATA_PROVIDER)
 * @param fallbackEnvVar Fallback (es: AI_PROVIDER)
 * @returns 'ollama' | 'openai'
 */
function getProvider(phaseEnvVar: string, fallbackEnvVar: string = 'AI_PROVIDER'): 'ollama' | 'openai' {
    const phase = process.env[phaseEnvVar];
    if (phase === 'ollama' || phase === 'openai') return phase;

    const fallback = process.env[fallbackEnvVar];
    if (fallback === 'ollama') return 'ollama';

    return 'openai'; // Default sicuro
}

/**
 * Ottiene il modello corretto per una fase
 * @param provider Provider attivo ('ollama' | 'openai')
 * @param openAIModelEnv Nome variabile OpenAI (es: OPEN_AI_MODEL_METADATA)
 * @param openAIFallback Fallback OpenAI (es: gpt-5-mini)
 * @param ollamaModel Modello Ollama (default: llama3.2)
 */
function getModel(
    provider: 'ollama' | 'openai',
    openAIModelEnv: string,
    openAIFallback: string,
    ollamaModel: string = process.env.OLLAMA_MODEL || 'llama3.2'
): string {
    if (provider === 'ollama') return ollamaModel;
    return process.env[openAIModelEnv] || openAIFallback;
}

/**
 * Crea un client OpenAI (Ollama o Cloud)
 */
function createClient(provider: 'ollama' | 'openai'): OpenAI {
    if (provider === 'ollama') {
        return new OpenAI({
            baseURL: process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434/v1',
            apiKey: 'ollama',
            timeout: 600 * 1000,
        });
    }

    return new OpenAI({
        apiKey: process.env.OPENAI_API_KEY || 'dummy',
        project: process.env.OPENAI_PROJECT_ID,
        timeout: 600 * 1000,
    });
}

// ============================================
// PROVIDER CONFIGURATION (Per-Phase)
// ============================================

const TRANSCRIPTION_PROVIDER = getProvider('TRANSCRIPTION_PROVIDER', 'AI_PROVIDER');
const METADATA_PROVIDER = getProvider('METADATA_PROVIDER', 'AI_PROVIDER');
const MAP_PROVIDER = getProvider('MAP_PROVIDER', 'AI_PROVIDER');
const SUMMARY_PROVIDER = getProvider('SUMMARY_PROVIDER', 'AI_PROVIDER');
const CHAT_PROVIDER = getProvider('CHAT_PROVIDER', 'AI_PROVIDER');
const EMBEDDING_PROVIDER = getProvider('EMBEDDING_PROVIDER', 'AI_PROVIDER');

// ============================================
// MODEL CONFIGURATION (Per-Phase)
// ============================================

const TRANSCRIPTION_MODEL = getModel(TRANSCRIPTION_PROVIDER, 'OPEN_AI_MODEL_TRANSCRIPTION', 'gpt-5-nano');
const METADATA_MODEL = getModel(METADATA_PROVIDER, 'OPEN_AI_MODEL_METADATA', 'gpt-5-mini');
const MAP_MODEL = getModel(MAP_PROVIDER, 'OPEN_AI_MODEL_MAP', 'gpt-5-mini');
const SUMMARY_MODEL = getModel(SUMMARY_PROVIDER, 'OPEN_AI_MODEL_SUMMARY', 'gpt-5.2');
const CHAT_MODEL = getModel(CHAT_PROVIDER, 'OPEN_AI_MODEL_CHAT', 'gpt-5-mini');

const EMBEDDING_MODEL_OPENAI = 'text-embedding-3-small';
const EMBEDDING_MODEL_OLLAMA = 'nomic-embed-text';
// NON creare EMBEDDING_MODEL unificato

// ============================================
// CLIENT CONFIGURATION (Per-Phase)
// ============================================

const transcriptionClient = createClient(TRANSCRIPTION_PROVIDER);
const metadataClient = createClient(METADATA_PROVIDER);
const mapClient = createClient(MAP_PROVIDER);
const summaryClient = createClient(SUMMARY_PROVIDER);
const chatClient = createClient(CHAT_PROVIDER);

// --- CLIENT DEDICATI PER EMBEDDING (DOPPIO) ---
const openaiEmbedClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'dummy',
  project: process.env.OPENAI_PROJECT_ID,
});

const ollamaEmbedClient = new OpenAI({
  baseURL: process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434/v1',
  apiKey: 'ollama',
});

// ============================================
// CONCURRENCY LIMITS
// ============================================

const TRANSCRIPTION_CONCURRENCY = TRANSCRIPTION_PROVIDER === 'ollama' ? 1 : 5;
const MAP_CONCURRENCY = MAP_PROVIDER === 'ollama' ? 1 : 5;
const EMBEDDING_BATCH_SIZE = EMBEDDING_PROVIDER === 'ollama' ? 1 : 5;

// ============================================
// CHUNK SIZE (Dynamic based on MAP_PROVIDER)
// ============================================

const MAX_CHUNK_SIZE = MAP_PROVIDER === 'ollama' ? 15000 : 800000;
const CHUNK_OVERLAP = MAP_PROVIDER === 'ollama' ? 1000 : 5000;

// ============================================
// DEBUG LOG (Startup)
// ============================================

console.log('\n🎭 BARDO AI - CONFIG GRANULARE');
console.log(`Correzione:  ${TRANSCRIPTION_PROVIDER.padEnd(8)} → ${TRANSCRIPTION_MODEL.padEnd(20)}`);
console.log(`Metadati:    ${METADATA_PROVIDER.padEnd(8)} → ${METADATA_MODEL.padEnd(20)}`);
console.log(`Map:         ${MAP_PROVIDER.padEnd(8)} → ${MAP_MODEL.padEnd(20)}`);
console.log(`Summary:     ${SUMMARY_PROVIDER.padEnd(8)} → ${SUMMARY_MODEL.padEnd(20)}`);
console.log(`Chat/RAG:    ${CHAT_PROVIDER.padEnd(8)} → ${CHAT_MODEL.padEnd(20)}`);
console.log(`Embeddings:  DOPPIO      → OpenAI (${EMBEDDING_MODEL_OPENAI}) + Ollama (${EMBEDDING_MODEL_OLLAMA})`);

// Interfaccia per la risposta dell'AI
interface AIResponse {
    segments: any[];
    detected_location?: {
        macro?: string; // Es. "Città di Neverwinter"
        micro?: string; // Es. "Locanda del Drago"
        confidence: string; // "high" o "low"
    };
    atlas_update?: string; // Nuova descrizione del luogo (se cambiata)
    npc_updates?: Array<{
        name: string;
        description: string;
        role?: string; // Opzionale
        status?: string; // Opzionale (es. "DEAD" se muore)
    }>;
    monsters?: Array<{
        name: string;
        status: "DEFEATED" | "ALIVE" | "FLED";
        count?: string; // Es. "1", "un branco", "molti"
    }>;
    present_npcs?: string[]; // Lista semplice di NPC presenti nella scena
}

// Interfaccia per il riassunto strutturato
export interface SummaryResponse {
    summary: string;
    title: string;
    tokens: number;
    loot?: string[];
    loot_removed?: string[];
    quests?: string[];
    narrative?: string;
    log?: string[];
    character_growth?: Array<{
        name: string;
        event: string;
        type: 'BACKGROUND' | 'TRAUMA' | 'RELATIONSHIP' | 'ACHIEVEMENT' | 'GOAL_CHANGE';
    }>;
    npc_events?: Array<{
        name: string;
        event: string;
        type: 'REVELATION' | 'BETRAYAL' | 'DEATH' | 'ALLIANCE' | 'STATUS_CHANGE' | 'GENERIC';
    }>;
    world_events?: Array<{
        event: string;
        type: 'WAR' | 'POLITICS' | 'DISCOVERY' | 'CALAMITY' | 'SUPERNATURAL' | 'GENERIC';
    }>;
}

/**
 * Divide il testo in chunk
 */
function splitTextInChunks(text: string, chunkSize: number = MAX_CHUNK_SIZE, overlap: number = CHUNK_OVERLAP): string[] {
    const chunks = [];
    let i = 0;
    while (i < text.length) {
        if (i + chunkSize >= text.length) {
            chunks.push(text.substring(i));
            break;
        }
        let end = i + chunkSize;
        const lastNewLine = text.lastIndexOf('\n', end);
        const lastSpace = text.lastIndexOf(' ', end);

        if (lastNewLine > i + (chunkSize * 0.9)) end = lastNewLine;
        else if (lastSpace > i + (chunkSize * 0.9)) end = lastSpace;

        chunks.push(text.substring(i, end));
        i = end - overlap;
    }
    return chunks;
}

/**
 * Retry con backoff esponenziale
 */
async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
    try {
        return await fn();
    } catch (err: any) {
        if (retries <= 0) throw err;

        if (err.status === 429) {
            // Gestione Rate Limit
            const jitter = Math.random() * 1000;
            console.warn(`[Bardo] 🛑 Rate Limit. Attesa forzata di ${(delay * 2 + jitter) / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay * 2 + jitter));
        } else {
            console.warn(`[Bardo] ⚠️ Errore API (Tentativi rimasti: ${retries}). Riprovo tra ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        return withRetry(fn, retries - 1, delay * 2);
    }
}

/**
 * Batch Processing con Progress Bar Integrata
 */
async function processInBatches<T, R>(
    items: T[],
    batchSize: number,
    fn: (item: T, index: number) => Promise<R>,
    taskName?: string
): Promise<R[]> {
    const results: R[] = [];
    const totalBatches = Math.ceil(items.length / batchSize);

    if (taskName) {
        console.log(`[Bardo] 🚀 Avvio ${taskName}: ${items.length} elementi in ${totalBatches} batch (Concorrenza: ${batchSize}).`);
    }

    let completedBatches = 0;

    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);

        // Esecuzione parallela del batch
        const batchResults = await Promise.all(batch.map((item, batchIndex) => fn(item, i + batchIndex)));
        results.push(...batchResults);

        completedBatches++;

        // Visualizzazione Progress Bar
        if (taskName) {
            const percent = Math.round((completedBatches / totalBatches) * 100);
            const filledLen = Math.round((20 * completedBatches) / totalBatches);
            const bar = '█'.repeat(filledLen) + '░'.repeat(20 - filledLen);

            if (totalBatches < 50 || completedBatches % 5 === 0 || completedBatches === totalBatches) {
                console.log(`[Bardo] ⏳ ${taskName}: ${completedBatches}/${totalBatches} [${bar}] ${percent}%`);
            }
        }
    }

    if (taskName) console.log(`[Bardo] ✅ ${taskName} completato.`);
    return results;
}

/**
 * Calcolo Similarità Coseno
 */
function cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// --- FASE 1: MAP ---
async function extractFactsFromChunk(chunk: string, index: number, total: number, castContext: string): Promise<{text: string, title: string, tokens: number}> {
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
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;

        monitor.logAIRequestWithCost(
            'map',
            MAP_PROVIDER,
            MAP_MODEL,
            inputTokens,
            outputTokens,
            cachedTokens,
            latency,
            false
        );

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

// --- RAG: INGESTION ---
export async function ingestSessionRaw(sessionId: string) {
    const campaignId = getSessionCampaignId(sessionId);
    if (!campaignId) {
        console.warn(`[RAG] ⚠️ Sessione ${sessionId} senza campagna. Salto ingestione.`);
        return;
    }

    console.log(`[RAG] 🧠 Ingestione RAW per sessione ${sessionId} (Doppio Embedding)...`);

    // 1. Pulisci vecchi frammenti per ENTRAMBI i modelli
    deleteSessionKnowledge(sessionId, EMBEDDING_MODEL_OPENAI);
    deleteSessionKnowledge(sessionId, EMBEDDING_MODEL_OLLAMA);

    // 2. Recupera e ricostruisci il dialogo completo
    const transcriptions = getSessionTranscript(sessionId);
    if (transcriptions.length === 0) return;

    const startTime = getSessionStartTime(sessionId) || 0;

    interface DialogueLine { timestamp: number; text: string; macro?: string | null; micro?: string | null; present_npcs?: string[] }
    const lines: DialogueLine[] = [];

    for (const t of transcriptions) {
        try {
            const segments = JSON.parse(t.transcription_text);
            const npcs = t.present_npcs ? t.present_npcs.split(',') : [];
            const charName = t.character_name || "Sconosciuto";

            if (Array.isArray(segments)) {
                for (const seg of segments) {
                    const absTime = t.timestamp + (seg.start * 1000);
                    const mins = Math.floor((absTime - startTime) / 60000);
                    const secs = Math.floor(((absTime - startTime) % 60000) / 1000);
                    const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;

                    lines.push({
                        timestamp: absTime,
                        text: `[${timeStr}] ${charName}: ${seg.text}`,
                        macro: t.macro_location,
                        micro: t.micro_location,
                        present_npcs: npcs
                    });
                }
            }
        } catch (e) { /* Ignora errori parsing */ }
    }

    lines.sort((a, b) => a.timestamp - b.timestamp);

    const allNpcs = listNpcs(campaignId, 1000);
    const npcNames = allNpcs.map(n => n.name);

    // 3. Sliding Window Chunking
    const fullText = lines.map(l => l.text).join("\n");
    const CHUNK_SIZE = 1000;
    const OVERLAP = 200;

    const chunks = [];
    let i = 0;
    while (i < fullText.length) {
        let end = Math.min(i + CHUNK_SIZE, fullText.length);
        if (end < fullText.length) {
            const lastNewLine = fullText.lastIndexOf('\n', end);
            if (lastNewLine > i + (CHUNK_SIZE * 0.5)) end = lastNewLine;
        }
        const chunkText = fullText.substring(i, end).trim();
        let chunkTimestamp = startTime;
        const timeMatch = chunkText.match(/\[(\d+):(\d+)\]/);
        if (timeMatch) chunkTimestamp = startTime + (parseInt(timeMatch[1]) * 60000) + (parseInt(timeMatch[2]) * 1000);

        const firstLine = lines.find(l => l.text.includes(chunkText.substring(0, 50)));
        const macro = firstLine?.macro || null;
        const micro = firstLine?.micro || null;

        const dbNpcs = firstLine?.present_npcs || [];
        const textNpcs = npcNames.filter(name => chunkText.toLowerCase().includes(name.toLowerCase()));
        const mergedNpcs = Array.from(new Set([...dbNpcs, ...textNpcs]));

        if (chunkText.length > 50) chunks.push({ text: chunkText, timestamp: chunkTimestamp, macro, micro, npcs: mergedNpcs });
        if (end >= fullText.length) break;
        i = end - OVERLAP;
    }

    // 4. Embedding con Progress Bar (DOPPIO - OpenAI + Ollama)
    await processInBatches(chunks, EMBEDDING_BATCH_SIZE, async (chunk, idx) => {
        const promises: any[] = [];
        const startAI = Date.now();

        // OpenAI Task
        promises.push(
            openaiEmbedClient.embeddings.create({
                model: EMBEDDING_MODEL_OPENAI,
                input: chunk.text
            })
            .then(resp => {
                const inputTokens = resp.usage?.prompt_tokens || 0;
                monitor.logAIRequestWithCost('embeddings', 'openai', EMBEDDING_MODEL_OPENAI, inputTokens, 0, 0, Date.now() - startAI, false);
                return { provider: 'openai', data: resp.data[0].embedding };
            })
            .catch(err => {
                monitor.logAIRequestWithCost('embeddings', 'openai', EMBEDDING_MODEL_OPENAI, 0, 0, 0, Date.now() - startAI, true);
                return { provider: 'openai', error: err.message };
            })
        );

        // Ollama Task
        promises.push(
            ollamaEmbedClient.embeddings.create({
                model: EMBEDDING_MODEL_OLLAMA,
                input: chunk.text
            })
            .then(resp => {
                monitor.logAIRequestWithCost('embeddings', 'ollama', EMBEDDING_MODEL_OLLAMA, 0, 0, 0, Date.now() - startAI, false);
                return { provider: 'ollama', data: resp.data[0].embedding };
            })
            .catch(err => {
                monitor.logAIRequestWithCost('embeddings', 'ollama', EMBEDDING_MODEL_OLLAMA, 0, 0, 0, Date.now() - startAI, true);
                return { provider: 'ollama', error: err.message };
            })
        );

        const results = await Promise.allSettled(promises);

        // Salva entrambi gli embedding se riusciti
        for (const res of results) {
            if (res.status === 'fulfilled') {
                const val = res.value as any;
                if (!val.error) {
                    insertKnowledgeFragment(
                        campaignId, sessionId, chunk.text,
                        val.data,
                        val.provider === 'openai' ? EMBEDDING_MODEL_OPENAI : EMBEDDING_MODEL_OLLAMA,
                        chunk.timestamp, chunk.macro, chunk.micro, chunk.npcs
                    );
                }
            }
        }
    }, 'Calcolo Embeddings RAG');
}

// --- RAG: SEARCH ---
export async function searchKnowledge(campaignId: number, query: string, limit: number = 5): Promise<string[]> {
    // Determina quale provider usare dalla variabile ambiente (runtime)
    const provider = process.env.EMBEDDING_PROVIDER || process.env.AI_PROVIDER || 'openai';
    const isOllama = provider === 'ollama';
    const model = isOllama ? EMBEDDING_MODEL_OLLAMA : EMBEDDING_MODEL_OPENAI;
    const client = isOllama ? ollamaEmbedClient : openaiEmbedClient;

    console.log(`[RAG] 🔍 Ricerca con ${model} (${provider})`);

    const startAI = Date.now();
    try {
        // 1. Calcolo Embedding Query
        const resp = await client.embeddings.create({
            model: model,
            input: query
        });

        const queryVector = resp.data[0].embedding;
        const inputTokens = resp.usage?.prompt_tokens || 0;
        
        monitor.logAIRequestWithCost(
            'embeddings',
            provider === 'ollama' ? 'ollama' : 'openai',
            model,
            inputTokens,
            0,
            0,
            Date.now() - startAI,
            false
        );

        // 2. Recupero Frammenti già ordinati per timestamp ASC dal DB
        let fragments = getKnowledgeFragments(campaignId, model);
        if (fragments.length === 0) return [];

        const allNpcs = listNpcs(campaignId, 1000);
        const mentionedNpcs = allNpcs.filter(npc => query.toLowerCase().includes(npc.name.toLowerCase()));

        if (mentionedNpcs.length > 0) {
            const filteredFragments = fragments.filter(f => {
                if (!f.associated_npcs) return false;
                const fragmentNpcs = f.associated_npcs.split(',').map(n => n.toLowerCase());
                return mentionedNpcs.some(mn => fragmentNpcs.includes(mn.name.toLowerCase()));
            });

            if (filteredFragments.length > 0) {
                fragments = filteredFragments;
            }
        }

        const currentLocation = getCampaignLocationById(campaignId);
        const currentMacro = currentLocation?.macro || "";
        const currentMicro = currentLocation?.micro || "";

        const scored = fragments.map((f, index) => {
            const vector = JSON.parse(f.embedding_json);
            let score = cosineSimilarity(queryVector, vector);

            if (currentMacro && f.macro_location === currentMacro) score += 0.05;
            if (currentMicro && f.micro_location === currentMicro) score += 0.10;

            return { ...f, score, originalIndex: index };
        });

        scored.sort((a, b) => b.score - a.score);

        const topK = scored.slice(0, limit);
        const finalIndices = new Set<number>();

        topK.forEach(item => {
            finalIndices.add(item.originalIndex);
            if (item.originalIndex - 1 >= 0) {
                const prev = fragments[item.originalIndex - 1];
                if (prev.session_id === item.session_id) finalIndices.add(item.originalIndex - 1);
            }
            if (item.originalIndex + 1 < fragments.length) {
                const next = fragments[item.originalIndex + 1];
                if (next.session_id === item.session_id) finalIndices.add(item.originalIndex + 1);
            }
        });

        const finalFragments = Array.from(finalIndices)
            .sort((a, b) => a - b)
            .map(idx => fragments[idx].content);

        return finalFragments;

    } catch (e) {
        console.error("[RAG] ❌ Errore ricerca:", e);
        monitor.logAIRequestWithCost(
            'embeddings',
            provider === 'ollama' ? 'ollama' : 'openai',
            model,
            0,
            0,
            0,
            Date.now() - startAI,
            true
        );
        return [];
    }
}

// --- RAG: ASK BARD ---
export async function askBard(campaignId: number, question: string, history: { role: 'user' | 'assistant', content: string }[] = []): Promise<string> {
    const context = await searchKnowledge(campaignId, question, 5);

    let contextText = context.length > 0
        ? "TRASCRIZIONI RILEVANTI (FONTE DI VERITÀ):\n" + context.map(c => `...\\n${c}\\n...`).join("\\n")
        : "Nessuna memoria specifica trovata.";

    const MAX_CONTEXT_CHARS = 12000;
    if (contextText.length > MAX_CONTEXT_CHARS) {
        contextText = contextText.substring(0, MAX_CONTEXT_CHARS) + "\n... [TESTO TRONCATO PER LIMITI DI MEMORIA]";
    }

    const loc = getCampaignLocationById(campaignId);
    let atmosphere = "Sei il Bardo della campagna. Rispondi in modo neutrale ma evocativo.";

    if (loc) {
        const micro = (loc.micro || "").toLowerCase();
        const macro = (loc.macro || "").toLowerCase();

        if (micro.includes('taverna') || micro.includes('locanda') || micro.includes('pub')) {
            atmosphere = "Sei un bardo allegro e un po' brillo. Usi slang da taverna, fai battute e c'è rumore di boccali in sottofondo.";
        } else if (micro.includes('cripta') || micro.includes('dungeon') || micro.includes('grotta') || micro.includes('tomba')) {
            atmosphere = "Parli sottovoce, sei teso e spaventato. Descrivi i suoni inquietanti dell'ambiente oscuro. Sei molto cauto.";
        } else if (micro.includes('tempio') || micro.includes('chiesa') || micro.includes('santuario')) {
            atmosphere = "Usi un tono solenne, rispettoso e quasi religioso. Parli con voce calma e misurata.";
        } else if (macro.includes('corte') || macro.includes('castello') || macro.includes('palazzo')) {
            atmosphere = "Usi un linguaggio aulico, formale e molto rispettoso. Sei un cronista di corte attento all'etichetta.";
        } else if (micro.includes('bosco') || micro.includes('foresta') || micro.includes('giungla')) {
            atmosphere = "Sei un bardo naturalista. Parli con meraviglia della natura, noti i suoni degli animali e il fruscio delle foglie.";
        }

        atmosphere += `\nLUOGO ATTUALE: ${loc.macro || "Sconosciuto"} - ${loc.micro || "Sconosciuto"}.`;
    }

    const relevantNpcs = findNpcDossierByName(campaignId, question);
    let socialContext = "";

    if (relevantNpcs.length > 0) {
        socialContext = "\n\n[[DOSSIER PERSONAGGI RILEVANTI]]\n";
        relevantNpcs.forEach((npc: any) => {
            socialContext += `- NOME: ${npc.name}\n  RUOLO: ${npc.role || 'Sconosciuto'}\n  STATO: ${npc.status}\n  INFO: ${npc.description}\n`;
        });
        socialContext += "Usa queste informazioni per arricchire la risposta, ma dai priorità ai fatti accaduti nelle trascrizioni.\n";
    }

    const systemPrompt = `${atmosphere}
    Il tuo compito è rispondere SOLO all'ULTIMA domanda posta dal giocatore, usando le trascrizioni fornite qui sotto.
    
    ${socialContext}

    ${contextText}
    
    REGOLAMENTO RIGIDO:
    1. La cronologia della chat serve SOLO per capire il contesto (es. se l'utente chiede "Come si chiama?", guarda i messaggi precedenti per capire di chi parla).
    2. NON ripetere mai le risposte già presenti nella cronologia.
    3. Rispondi in modo diretto e conciso alla domanda corrente.
    4. Se trovi informazioni contrastanti nelle trascrizioni, riportale come voci diverse.
    5. Se la risposta non è nelle trascrizioni, ammetti di non ricordare.`;

    const messages: any[] = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: question }];

    const startAI = Date.now();
    try {
        const response = await withRetry(() => chatClient.chat.completions.create({
            model: CHAT_MODEL,
            messages: messages as any
        }));
        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;

        monitor.logAIRequestWithCost(
            'chat',
            CHAT_PROVIDER,
            CHAT_MODEL,
            inputTokens,
            outputTokens,
            cachedTokens,
            latency,
            false
        );

        return response.choices[0].message.content || "Il Bardo è muto.";
    } catch (e) {
        console.error("[Chat] Errore risposta:", e);
        monitor.logAIRequestWithCost('chat', CHAT_PROVIDER, CHAT_MODEL, 0, 0, 0, Date.now() - startAI, true);
        return "La mia mente è annebbiata...";
    }
}

// --- FASE 1: CORREZIONE TESTO GREZZO ---
async function correctTextOnly(segments: any[]): Promise<any[]> {
    const BATCH_SIZE = 20;
    const allBatches: any[][] = [];
    
    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
        allBatches.push(segments.slice(i, i + BATCH_SIZE));
    }

    const cleanText = (text: string): string => {
        if (!text) return "";
        return text.trim()
            .replace(/\[SILENZIO\]/g, "")
            .replace(/Sottotitoli.*/gi, "")
            .replace(/Amara\.org/gi, "")
            .replace(/creati dalla comunità/gi, "")
            .replace(/\s+/g, " ")
            .trim();
    };

    const results = await processInBatches(
        allBatches,
        TRANSCRIPTION_CONCURRENCY,
        async (batch, idx) => {
            const prompt = `Correggi ortografia e punteggiatura in italiano.
- Rimuovi riempitivi (ehm, uhm).
- NON aggiungere commenti.
- IMPORTANTE: Restituisci ESATTAMENTE ${batch.length} righe, una per riga.
- NON unire né dividere frasi.
- Se una riga è vuota o incomprensibile, scrivi "..."

TESTO DA CORREGGERE (${batch.length} righe):
${batch.map((s, i) => `${i+1}. ${s.text}`).join('\n')}`;

            const startAI = Date.now();
            try {
                const response = await withRetry(() =>
                    transcriptionClient.chat.completions.create({
                        model: TRANSCRIPTION_MODEL,
                        messages: [
                            { role: "system", content: "Correttore ortografico conciso." },
                            { role: "user", content: prompt }
                        ]
                    })
                );

                const latency = Date.now() - startAI;
                const inputTokens = response.usage?.prompt_tokens || 0;
                const outputTokens = response.usage?.completion_tokens || 0;
                const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;

                monitor.logAIRequestWithCost(
                    'transcription',
                    TRANSCRIPTION_PROVIDER,
                    TRANSCRIPTION_MODEL,
                    inputTokens,
                    outputTokens,
                    cachedTokens,
                    latency,
                    false
                );

                const rawOutput = response.choices[0].message.content || "";
                const lines = rawOutput.split('\n')
                    .map(l => l.replace(/^\d+\.\s*/, '').trim())
                    .filter(l => l.length > 0);

                // ✅ TOLLERANZA MISMATCH (±20%)
                const tolerance = Math.ceil(batch.length * 0.2);
                const diff = Math.abs(lines.length - batch.length);

                if (lines.length !== batch.length) {
                    if (diff <= tolerance) {
                        console.warn(`[Correzione] ⚠️ Batch ${idx+1}: Mismatch tollerato (${lines.length}≠${batch.length}, diff: ${diff})`);
                        
                        // Padding o Truncate
                        return batch.map((orig, i) => ({
                            ...orig,
                            text: cleanText(lines[i] || orig.text)
                        }));
                    }
                    
                    console.warn(`[Correzione] ⚠️ Batch ${idx+1}: Mismatch eccessivo (${lines.length}≠${batch.length}). Uso originale.`);
                    return batch;
                }

                return batch.map((orig, i) => ({
                    ...orig,
                    text: cleanText(lines[i])
                }));

            } catch (err) {
                console.error(`[Correzione] ❌ Errore batch ${idx+1}:`, err);
                monitor.logAIRequestWithCost('transcription', TRANSCRIPTION_PROVIDER, TRANSCRIPTION_MODEL, 0, 0, 0, Date.now() - startAI, true);
                return batch;
            }
        },
        `Correzione (${TRANSCRIPTION_PROVIDER})`
    );

    return results.flat();
}

// --- FASE 2: ESTRAZIONE METADATI ---
async function extractMetadata(
    correctedSegments: any[],
    campaignId?: number
): Promise<{
    detected_location?: any;
    atlas_update?: string;
    npc_updates?: any[];
    monsters?: any[];
    present_npcs?: string[];
}> {
    // 🆕 BATCHING DEI METADATI
    // Invece di processare tutto in un colpo solo (che potrebbe superare i limiti di token)
    // o processare riga per riga (che è inefficiente), usiamo una finestra scorrevole.
    
    // Se il testo è breve, processiamo tutto insieme
    const fullText = correctedSegments.map(s => s.text).join('\n');
    if (fullText.length < 15000) { // Limite arbitrario sicuro per gpt-4o-mini
        return extractMetadataSingleBatch(fullText, campaignId, METADATA_PROVIDER);
    }

    // Se è lungo, dividiamo in chunk logici
    console.log(`[Metadati] 🐘 Testo lungo (${fullText.length} chars). Batching attivato.`);
    
    const CHUNK_SIZE = 20; // Numero di segmenti per batch
    const OVERLAP = 5;     // Sovrapposizione per non perdere contesto tra i batch
    
    const chunks: any[][] = [];
    for (let i = 0; i < correctedSegments.length; i += (CHUNK_SIZE - OVERLAP)) {
        chunks.push(correctedSegments.slice(i, i + CHUNK_SIZE));
    }

    const results = await processInBatches(chunks, 3, async (batch, idx) => {
        const batchText = batch.map(s => s.text).join('\n');
        return extractMetadataSingleBatch(batchText, campaignId, METADATA_PROVIDER);
    }, "Estrazione Metadati (Batch)");

    // Aggregazione risultati
    const aggregated: any = {
        detected_location: null, // Prendiamo l'ultimo valido o il più frequente? Per ora l'ultimo non nullo.
        atlas_update: null,
        npc_updates: [],
        monsters: [],
        present_npcs: []
    };

    for (const res of results) {
        if (res.detected_location && res.detected_location.confidence === 'high') {
            aggregated.detected_location = res.detected_location;
        }
        if (res.atlas_update) aggregated.atlas_update = res.atlas_update; // Sovrascrive, forse meglio concatenare?
        if (res.npc_updates) aggregated.npc_updates.push(...res.npc_updates);
        if (res.monsters) aggregated.monsters.push(...res.monsters);
        if (res.present_npcs) aggregated.present_npcs.push(...res.present_npcs);
    }

    // Deduplica NPC
    aggregated.present_npcs = Array.from(new Set(aggregated.present_npcs));
    
    // Se non abbiamo trovato location high confidence, proviamo con l'ultima low confidence
    if (!aggregated.detected_location) {
        const lastLow = results.reverse().find(r => r.detected_location);
        if (lastLow) aggregated.detected_location = lastLow.detected_location;
    }

    return aggregated;
}

async function extractMetadataSingleBatch(
    text: string,
    campaignId?: number,
    provider: 'openai' | 'ollama' = 'openai'
): Promise<{
    detected_location?: any;
    atlas_update?: string;
    npc_updates?: any[];
    monsters?: any[];
    present_npcs?: string[];
}> {
    let contextInfo = "Contesto: Sessione D&D.";
    let currentLocationMsg = "Luogo: Sconosciuto.";
    let atlasContext = "";

    if (campaignId) {
        const campaign = getCampaignById(campaignId);
        if (campaign) {
            contextInfo += `\nCampagna: "${campaign.name}".`;
            // @ts-ignore
            const loc: LocationState = {
                macro: campaign.current_macro_location!,
                micro: campaign.current_micro_location!
            };

            if (loc.macro || loc.micro) {
                currentLocationMsg = `LUOGO ATTUALE: ${loc.macro || ''} - ${loc.micro || ''}`;
                if (loc.macro && loc.micro) {
                    const lore = getAtlasEntry(campaignId, loc.macro, loc.micro);
                    atlasContext = lore ? `\nINFO LUOGO: ${lore}` : "";
                }
            }

            const characters = getCampaignCharacters(campaignId);
            if (characters.length > 0) {
                contextInfo += "\nPG: " + characters.map(c => c.character_name).join(", ");
            }
        }
    }

    const prompt = `Analizza questa trascrizione di una sessione D&D.

${contextInfo}
${currentLocationMsg}
${atlasContext}

**ISTRUZIONI CRITICHE:**
1. **Rispondi SEMPRE in italiano puro**
2. Descrivi luoghi, personaggi e azioni in italiano
3. Non mescolare inglese nelle descrizioni
4. Usa termini italiani anche per concetti fantasy

**COMPITI:**
1. Rileva cambio di luogo (macro/micro-location)
2. Distingui RIGOROSAMENTE tra NPC (Personaggi con nome, ruolo sociale, alleati o neutrali) e MOSTRI (Bestie, nemici anonimi, creature ostili).
3. Rileva aggiornamenti alle descrizioni dei luoghi
4. Rileva nuove informazioni sugli NPC (ruolo, status)

**TESTO DA ANALIZZARE:**
${text}

**FORMATO OUTPUT (JSON OBBLIGATORIO):**
{
  "detected_location": {
    "macro": "Nome città/regione",
    "micro": "Nome specifico luogo",
    "confidence": "high" o "low",
    "description": "Descrizione dettagliata in ITALIANO"
  },
  "atlas_update": "Aggiornamento descrizione luogo (se necessario, in ITALIANO)",
  "npc_updates": [
    {
      "name": "Nome NPC",
      "description": "Descrizione in ITALIANO",
      "role": "Ruolo in ITALIANO (es. 'Mercante', 'Guardia')",
      "status": "ALIVE o DEAD"
    }
  ],
  "monsters": [
      { "name": "Nome Mostro", "status": "DEFEATED" | "ALIVE" | "FLED", "count": "numero o descrizione" }
  ],
  "present_npcs": ["NPC1", "NPC2"]
}

**ESEMPIO CORRETTO:**
{
  "detected_location": {
    "macro": "Waterdeep",
    "micro": "Taverna del Drago Dorato",
    "confidence": "high",
    "description": "Locale affollato, odore di birra e arrosto, camino acceso"
  },
  "npc_updates": [
    {
      "name": "Elminster",
      "description": "Mago anziano con barba bianca",
      "role": "Arcimago",
      "status": "ALIVE"
    }
  ],
  "monsters": [
      { "name": "Goblin", "status": "DEFEATED", "count": "3" },
      { "name": "Drago Rosso", "status": "FLED", "count": "1" }
  ],
  "present_npcs": ["Elminster"]
}

Istruzione extra: "NON inserire mostri generici (es. 'Ragno', 'Orco') nella lista 'npc_updates'. Mettili solo in 'monsters'."

Rispondi SOLO con il JSON, senza altro testo.`;

    const startAI = Date.now();
    try {
        const options: any = {
            model: METADATA_MODEL,
            messages: [
                { role: "system", content: "Sei un assistente esperto di D&D. Rispondi SEMPRE in italiano. Output: solo JSON valido, descrizioni dettagliate in italiano." },
                { role: "user", content: prompt }
            ]
        };

        // Solo OpenAI supporta response_format
        if (provider === 'openai') {
            options.response_format = { type: "json_object" };
        }

        const response = await withRetry(() => metadataClient.chat.completions.create(options));
        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;

        monitor.logAIRequestWithCost(
            'metadata',
            METADATA_PROVIDER,
            METADATA_MODEL,
            inputTokens,
            outputTokens,
            cachedTokens,
            latency,
            false
        );

        const rawContent = response.choices[0].message.content || "{}";
        
        // USO LA NUOVA FUNZIONE SAFE PARSE
        const parsed = safeJsonParse(rawContent);
        
        if (!parsed) {
            console.error(`[Metadati] ❌ JSON Parse Error con ${provider}. Raw: ${rawContent.substring(0, 50)}...`);
            
            // Se Ollama fallisce, fallback a OpenAI
            if (provider === 'ollama') {
                console.log(`[Metadati] 🔄 Fallback a OpenAI...`);
                return extractMetadataSingleBatch(text, campaignId, 'openai');
            }
            
            return { detected_location: null, npc_updates: [], present_npcs: [] };
        }

        // Validazione minima
        if (!parsed.detected_location && !parsed.present_npcs) {
             // Se è vuoto ma valido, ok.
        }
        return parsed;

    } catch (err) {
        console.error(`[Metadati] ❌ Errore:`, err);
        monitor.logAIRequestWithCost('metadata', METADATA_PROVIDER, METADATA_MODEL, 0, 0, 0, Date.now() - startAI, true);
        return {};
    }
}

// --- FUNZIONE PRINCIPALE REFACTORATA ---
export async function correctTranscription(
    segments: any[],
    campaignId?: number
): Promise<AIResponse> {
    console.log(`[Bardo] 🔧 Avvio correzione (Provider: ${TRANSCRIPTION_PROVIDER})...`);

    // STEP 1: Correzione Testuale Bulk
    const correctedSegments = await correctTextOnly(segments);

    // STEP 2: Estrazione Metadati
    const metadata = await extractMetadata(correctedSegments, campaignId);

    return {
        segments: correctedSegments,
        ...metadata
    };
}

// --- FUNZIONE PRINCIPALE (RIASSUNTO) ---
export async function generateSummary(sessionId: string, tone: ToneKey = 'DM'): Promise<SummaryResponse> {
    console.log(`[Bardo] 📚 Generazione Riassunto per sessione ${sessionId} (Model: ${SUMMARY_MODEL})...`);

    const transcriptions = getSessionTranscript(sessionId);
    const notes = getSessionNotes(sessionId);
    const startTime = getSessionStartTime(sessionId) || 0;
    const campaignId = getSessionCampaignId(sessionId);

    if (transcriptions.length === 0 && notes.length === 0) return { summary: "Nessuna trascrizione trovata.", title: "Sessione Vuota", tokens: 0 };

    const userIds = new Set(transcriptions.map(t => t.user_id));
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
    } else {
        castContext += "Nota: Profili personaggi non disponibili per questa sessione legacy.\n";
    }

    // --- TOTAL RECALL (CONTEXT INJECTION) ---
    let memoryContext = "";
    if (campaignId) {
        console.log(`[Bardo] 🧠 Avvio Total Recall per campagna ${campaignId}...`);
        const snapshot = getCampaignSnapshot(campaignId);
        const activeCharNames = snapshot.characters.map((c: any) => c.character_name).filter(Boolean);
        const activeQuestTitles = snapshot.quests.map((q: any) => q.title);
        const locationQuery = snapshot.location ? `${snapshot.location.macro || ''} ${snapshot.location.micro || ''}`.trim() : "";

        const promises = [];
        if (locationQuery) promises.push(searchKnowledge(campaignId, `Eventi passati a ${locationQuery}`, 3).then(res => ({ type: 'LUOGO', data: res })));
        if (activeCharNames.length > 0) promises.push(searchKnowledge(campaignId, `Fatti su ${activeCharNames.join(', ')}`, 3).then(res => ({ type: 'PERSONAGGI', data: res })));
        if (activeQuestTitles.length > 0) promises.push(searchKnowledge(campaignId, `Dettagli quest: ${activeQuestTitles.join(', ')}`, 3).then(res => ({ type: 'MISSIONI', data: res })));

        const ragResults = await Promise.all(promises);

        memoryContext = `\n[[MEMORIA DEL MONDO]]\n`;
        memoryContext += `📍 LUOGO: ${snapshot.location_context}\n`;
        if (snapshot.atlasDesc) memoryContext += `📖 DESCRIZIONE AMBIENTE: ${snapshot.atlasDesc}\n`;
        memoryContext += `⚔️ MISSIONI ATTIVE: ${snapshot.quest_context}\n`;

        ragResults.forEach(res => {
            if (res.data && res.data.length > 0) {
                memoryContext += `\nRICORDI (${res.type}):\n${res.data.map(s => `- ${s}`).join('\n')}\n`;
            }
        });
        memoryContext += `\n--------------------------------------------------\n`;
    }

    // Ricostruzione dialogo lineare
    const allFragments = [];
    for (const t of transcriptions) {
        try {
            const segments = JSON.parse(t.transcription_text);
            const charName = t.character_name || "Sconosciuto";
            if (Array.isArray(segments)) {
                for (const seg of segments) {
                    allFragments.push({
                        absoluteTime: t.timestamp + (seg.start * 1000),
                        character: charName,
                        text: seg.text,
                        type: 'audio',
                        macro: t.macro_location,
                        micro: t.micro_location
                    });
                }
            }
        } catch (e) {}
    }

    for (const n of notes) {
        const p = getUserProfile(n.user_id, campaignId || 0);
        allFragments.push({
            absoluteTime: n.timestamp,
            character: p.character_name || "Giocatore",
            text: `[NOTA UTENTE] ${n.content}`,
            type: 'note',
            macro: null,
            micro: null
        });
    }

    allFragments.sort((a, b) => a.absoluteTime - b.absoluteTime);

    let lastMacro: string | null | undefined = null;
    let lastMicro: string | null | undefined = null;

    let fullDialogue = allFragments.map(f => {
        const minutes = Math.floor((f.absoluteTime - startTime) / 60000);
        const seconds = Math.floor(((f.absoluteTime - startTime) % 60000) / 1000);
        const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        const prefix = f.type === 'note' ? '📝 ' : '';

        let sceneMarker = "";
        if (f.type === 'audio' && (f.macro !== lastMacro || f.micro !== lastMicro)) {
            if (f.macro || f.micro) {
                sceneMarker = `\n--- CAMBIO SCENA: [${f.macro || "Invariato"}] - [${f.micro || "Invariato"}] ---\n`;
                lastMacro = f.macro;
                lastMicro = f.micro;
            }
        }

        return `${sceneMarker}${prefix}[${timeStr}] ${f.character}: ${f.text}`;
    }).join("\n");

    let contextForFinalStep = "";
    let accumulatedTokens = 0;

    // FASE MAP: Analisi frammenti
    if (fullDialogue.length > MAX_CHUNK_SIZE) {
        console.log(`[Bardo] 🐘 Testo lungo (${fullDialogue.length} chars). Avvio Map-Reduce.`);
        const chunks = splitTextInChunks(fullDialogue, MAX_CHUNK_SIZE, CHUNK_OVERLAP);
        const mapResults = await processInBatches(chunks, MAP_CONCURRENCY, async (chunk, index) => {
            return await extractFactsFromChunk(chunk, index, chunks.length, castContext);
        }, "Analisi Frammenti (Map Phase)");

        contextForFinalStep = mapResults.map(r => r.text).join("\n\n--- SEGMENTO SUCCESSIVO ---\n\n");
        accumulatedTokens = mapResults.reduce((acc, curr) => acc + curr.tokens, 0);
    } else {
        contextForFinalStep = fullDialogue;
    }

    // FASE REDUCE: Scrittura finale
    console.log(`[Bardo] ✍️  Fase REDUCE: Scrittura racconto finale (${tone})...`);

    let reducePrompt = "";
    if (tone === 'DM') {
        reducePrompt = `Sei un assistente esperto di D&D (Dungeons & Dragons). 
Analizza la seguente trascrizione grezza di una sessione di gioco.
Il tuo compito è estrarre informazioni strutturate E scrivere un riassunto narrativo.

CONTESTO:
${castContext}
${memoryContext}

Devi rispondere ESCLUSIVAMENTE con un oggetto JSON valido in questo formato esatto:
{
  "title": "Titolo evocativo della sessione",
  "narrative": "Scrivi qui un riassunto discorsivo e coinvolgente degli eventi, scritto come un racconto in terza persona al passato (es: 'Il gruppo è arrivato alla zona Ovest...'). Usa un tono epico ma conciso. Includi i colpi di scena e le interazioni principali.",
    "loot": [
        "FORMATO: Nome Oggetto (proprietà magiche se presenti)",
        "SE oggetto magico: Arma Magica (+bonus attacco, effetto speciale se presente)",
        "SE valuta semplice: 100 monete d'oro",
        "IMPORTANTE: Estrai SOLO oggetti menzionati nella trascrizione, NON inventare!"
    ],
  "loot_removed": ["lista", "oggetti", "persi/usati"],
  "quests": ["lista", "missioni", "accettate/completate"],
  "character_growth": [
    { 
        "name": "Nome PG", 
        "event": "Descrizione dell'evento significativo", 
        "type": "TRAUMA" 
    }
  ],
  "npc_events": [
      {
          "name": "Nome NPC",
          "event": "Descrizione dell'evento chiave",
          "type": "ALLIANCE"
      }
  ],
  "world_events": [
      {
          "event": "Descrizione dell'evento globale",
          "type": "POLITICS"
      }
  ],
  "log": [
    "[luogo - stanza] Chi -> Azione -> Risultato"
  ]
}

REGOLE IMPORTANTI:
1. "narrative": Deve essere un testo fluido, non un elenco. Racconta la storia della sessione.
2. "loot": Solo oggetti di valore, monete o oggetti magici.
3. "log": Sii conciso. Usa il formato [Luogo] Chi -> Azione.
4. Rispondi SEMPRE in ITALIANO.
5. IMPORTANTE: 'loot', 'loot_removed' e 'quests' devono essere array di STRINGHE SEMPLICI, NON oggetti.

**REGOLE PER IL LOOT:**
- Oggetti magici/unici: Descrivi proprietà e maledizioni.
- Valuta semplice: Scrivi solo "X monete d'oro".
- Se un oggetto viene solo menzionato ma non descritto, scrivi il nome base.
`;
    } else {
        reducePrompt = `Sei un Bardo. ${TONES[tone] || TONES.EPICO}
        ${castContext}
        ${memoryContext}
        
        ISTRUZIONI DI STILE:
        - "Show, don't tell": Non dire che un personaggio è coraggioso, descrivi le sue azioni intrepide.
        - Se le azioni di un personaggio contraddicono il suo profilo, dai priorità ai fatti accaduti nelle sessioni.
        - Attribuisci correttamente i dialoghi agli NPC specifici anche se provengono tecnicamente dalla trascrizione del Dungeon Master, basandoti sul contesto della scena.
        - Le righe marcate con 📝 [NOTA UTENTE] sono fatti certi inseriti manualmente dai giocatori. Usale come punti fermi della narrazione, hanno priorità sull'audio trascritto.
        - Usa i marker "--- CAMBIO SCENA ---" nel testo per strutturare il riassunto in capitoli o paragrafi distinti basati sui luoghi.

        Usa gli appunti seguenti per scrivere un riassunto coerente della sessione.
        
        ISTRUZIONI DI FORMATTAZIONE RIGIDE:
        1. Non usare preamboli (es. "Ecco il riassunto").
        2. Non usare chiusure conversazionali (es. "Fammi sapere se...", "Spero ti piaccia").
        3. Non offrire di convertire il testo in altri formati o chiedere dettagli sul sistema di gioco.
        4. L'output deve essere un oggetto JSON valido con le seguenti chiavi:
           - "title": Un titolo evocativo per la sessione.
           - "summary": Il testo narrativo completo.
           - "loot": Array di stringhe contenente gli oggetti ottenuti (es. ["Spada +1", "100 monete d'oro"]). Se nessuno, array vuoto.
           - "loot_removed": Array di stringhe contenente gli oggetti consumati, persi o venduti. Se nessuno, array vuoto.
           - "quests": Array di stringhe contenente le missioni accettate, aggiornate o concluse. Se nessuna, array vuoto.
           - "character_growth": Array di oggetti {name, event, type} per eventi significativi dei personaggi.
        5. LUNGHEZZA MASSIMA: Il riassunto NON DEVE superare i 6500 caratteri. Sii conciso ma evocativo.
        6. IMPORTANTE: 'loot', 'loot_removed' e 'quests' devono essere array di STRINGHE SEMPLICI, NON oggetti.`;
    }

    const startAI = Date.now();
    try {
        const options: any = {
            model: SUMMARY_MODEL,
            messages: [
                { role: "system", content: "Sei un assistente D&D esperto. Rispondi SOLO con JSON valido." },
                { role: "user", content: `${reducePrompt}\n\nTRASCRIZIONE:\n${contextForFinalStep}` }
            ]
        };

        if (SUMMARY_PROVIDER === 'openai') {
            options.response_format = { type: "json_object" };
        } else if (SUMMARY_PROVIDER === 'ollama') {
            options.format = 'json';
            options.options = {
                num_ctx: 8192
            };
        }

        const response = await withRetry(() => summaryClient.chat.completions.create(options));
        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;

        monitor.logAIRequestWithCost(
            'summary',
            SUMMARY_PROVIDER,
            SUMMARY_MODEL,
            inputTokens,
            outputTokens,
            cachedTokens,
            latency,
            false
        );

        const content = response.choices[0].message.content || "{}";
        accumulatedTokens += response.usage?.total_tokens || 0;

        let parsed;
        try {
            // USO LA NUOVA FUNZIONE SAFE PARSE
            parsed = safeJsonParse(content);
            
            if (!parsed) {
                throw new Error("JSON Parsing fallito (restituito null)");
            }

        } catch (e) {
            console.error("[Bardo] ⚠️ Errore parsing JSON Riassunto:", e);
            // Fallback: se il JSON fallisce, usa l'intero contenuto come testo narrativo
            parsed = { 
                title: "Sessione (Errore Parsing)", 
                summary: content, // Salviamo tutto il testo grezzo per non perdere il lavoro
                loot: [], 
                loot_removed: [], 
                quests: [] 
            };
        }

        let finalSummary = parsed.summary;
        if (Array.isArray(parsed.log)) {
            finalSummary = parsed.log.join('\n');
        } else if (!finalSummary && parsed.narrative) {
            finalSummary = parsed.narrative;
        }

        return {
            summary: finalSummary || "Errore generazione.",
            title: parsed.title || "Sessione Senza Titolo",
            tokens: accumulatedTokens,
            // NORMALIZZAZIONE LISTE (Evita oggetti nel DB)
            loot: normalizeStringList(parsed.loot),
            loot_removed: normalizeStringList(parsed.loot_removed),
            quests: normalizeStringList(parsed.quests),
            narrative: parsed.narrative,
            log: Array.isArray(parsed.log) ? parsed.log : [],
            character_growth: Array.isArray(parsed.character_growth) ? parsed.character_growth : [],
            npc_events: Array.isArray(parsed.npc_events) ? parsed.npc_events : [],
            world_events: Array.isArray(parsed.world_events) ? parsed.world_events : []
        };
    } catch (err: any) {
        console.error("Errore finale:", err);
        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, 0, 0, 0, Date.now() - startAI, true);
        throw err;
    }
}

// --- GENERATORE BIOGRAFIA ---
export async function generateCharacterBiography(campaignId: number, charName: string, charClass: string, charRace: string): Promise<string> {
    const history = getCharacterHistory(campaignId, charName);

    if (history.length === 0) {
        return `Non c'è ancora abbastanza storia scritta su ${charName}.`;
    }

    const eventsText = history.map((h: any) => `[${h.event_type}] ${h.description}`).join('\n');

    const prompt = `Sei un biografo fantasy epico.
    Scrivi la "Storia finora" del personaggio ${charName} (${charRace} ${charClass}).
    
    Usa la seguente cronologia di eventi significativi raccolti durante le sessioni:
    ${eventsText}
    
    ISTRUZIONI:
    1. Unisci gli eventi in un racconto fluido e coinvolgente.
    2. Evidenzia l'evoluzione psicologica del personaggio (es. come i traumi lo hanno cambiato).
    3. Non fare un elenco puntato, scrivi in prosa.
    4. Usa un tono solenne e introspettivo.
    5. Concludi con una frase sullo stato attuale del personaggio.`;

    const startAI = Date.now();
    try {
        const response = await summaryClient.chat.completions.create({
            model: SUMMARY_MODEL,
            messages: [{ role: "user", content: prompt }]
        });
        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;

        monitor.logAIRequestWithCost(
            'summary',
            SUMMARY_PROVIDER,
            SUMMARY_MODEL,
            inputTokens,
            outputTokens,
            cachedTokens,
            latency,
            false
        );

        return response.choices[0].message.content || "Impossibile scrivere la biografia.";
    } catch (e) {
        console.error("Errore generazione bio:", e);
        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, 0, 0, 0, Date.now() - startAI, true);
        return "Il biografo ha finito l'inchiostro.";
    }
}

// --- GENERATORE BIOGRAFIA NPC ---
export async function generateNpcBiography(campaignId: number, npcName: string, role: string, staticDesc: string): Promise<string> {
    const history = getNpcHistory(campaignId, npcName);

    const historyText = history.length > 0
        ? history.map((h: any) => `[${h.event_type}] ${h.description}`).join('\n')
        : "Nessun evento storico registrato.";

    const prompt = `Sei un biografo fantasy.
    Scrivi la storia dell'NPC: **${npcName}**.
    
    RUOLO ATTUALE: ${role}
    DESCRIZIONE GENERALE: ${staticDesc}
    
    CRONOLOGIA EVENTI (Apparsi nelle sessioni):
    ${historyText}
    
    ISTRUZIONI:
    1. Unisci la descrizione generale con gli eventi cronologici per creare un profilo completo.
    2. Se ci sono eventi storici, usali per spiegare come è arrivato alla situazione attuale.
    3. Se non ci sono eventi storici, basati sulla descrizione generale espandendola leggermente.
    4. Usa un tono descrittivo, come una voce di enciclopedia o un dossier segreto.`;

    const startAI = Date.now();
    try {
        const response = await summaryClient.chat.completions.create({
            model: SUMMARY_MODEL,
            messages: [{ role: "user", content: prompt }]
        });
        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;

        monitor.logAIRequestWithCost(
            'summary',
            SUMMARY_PROVIDER,
            SUMMARY_MODEL,
            inputTokens,
            outputTokens,
            cachedTokens,
            latency,
            false
        );

        return response.choices[0].message.content || "Impossibile scrivere il dossier.";
    } catch (e) {
        console.error("Errore generazione bio NPC:", e);
        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, 0, 0, 0, Date.now() - startAI, true);
        return "Il dossier è bruciato.";
    }
}

// --- RAG: INGESTIONE BIOGRAFIA ---
export async function ingestBioEvent(campaignId: number, sessionId: string, charName: string, event: string, type: string) {
    const content = `BIOGRAFIA ${charName}: TIPO ${type}. EVENTO: ${event}`;
    console.log(`[RAG] 🎭 Indicizzazione evento bio per ${charName}...`);

    const promises: any[] = [];
    const startAI = Date.now();

    // OpenAI Task
    promises.push(
        openaiEmbedClient.embeddings.create({
            model: EMBEDDING_MODEL_OPENAI,
            input: content
        })
        .then(resp => {
            const inputTokens = resp.usage?.prompt_tokens || 0;
            monitor.logAIRequestWithCost('embeddings', 'openai', EMBEDDING_MODEL_OPENAI, inputTokens, 0, 0, Date.now() - startAI, false);
            return { provider: 'openai', data: resp.data[0].embedding };
        })
        .catch(err => {
            monitor.logAIRequestWithCost('embeddings', 'openai', EMBEDDING_MODEL_OPENAI, 0, 0, 0, Date.now() - startAI, true);
            return { provider: 'openai', error: err.message };
        })
    );

    // Ollama Task
    promises.push(
        ollamaEmbedClient.embeddings.create({
            model: EMBEDDING_MODEL_OLLAMA,
            input: content
        })
        .then(resp => {
            monitor.logAIRequestWithCost('embeddings', 'ollama', EMBEDDING_MODEL_OLLAMA, 0, 0, 0, Date.now() - startAI, false);
            return { provider: 'ollama', data: resp.data[0].embedding };
        })
        .catch(err => {
            monitor.logAIRequestWithCost('embeddings', 'ollama', EMBEDDING_MODEL_OLLAMA, 0, 0, 0, Date.now() - startAI, true);
            return { provider: 'ollama', error: err.message };
        })
    );

    const results = await Promise.allSettled(promises);

    for (const res of results) {
        if (res.status === 'fulfilled') {
            const val = res.value as any;
            if (!val.error) {
                insertKnowledgeFragment(
                    campaignId, sessionId, content,
                    val.data,
                    val.provider === 'openai' ? EMBEDDING_MODEL_OPENAI : EMBEDDING_MODEL_OLLAMA,
                    0, // timestamp fittizio
                    null, // macro
                    null, // micro
                    [charName] // associamo esplicitamente il NPC/PG
                );
            }
        }
    }
}

// --- RAG: INGESTIONE CRONACA MONDIALE ---
export async function ingestWorldEvent(campaignId: number, sessionId: string, event: string, type: string) {
    const content = `STORIA DEL MONDO: TIPO ${type}. EVENTO: ${event}`;
    console.log(`[RAG] 🌍 Indicizzazione evento globale...`);

    const promises: any[] = [];
    const startAI = Date.now();

    // OpenAI Task
    promises.push(
        openaiEmbedClient.embeddings.create({
            model: EMBEDDING_MODEL_OPENAI,
            input: content
        })
        .then(resp => {
            const inputTokens = resp.usage?.prompt_tokens || 0;
            monitor.logAIRequestWithCost('embeddings', 'openai', EMBEDDING_MODEL_OPENAI, inputTokens, 0, 0, Date.now() - startAI, false);
            return { provider: 'openai', data: resp.data[0].embedding };
        })
        .catch(err => {
            monitor.logAIRequestWithCost('embeddings', 'openai', EMBEDDING_MODEL_OPENAI, 0, 0, 0, Date.now() - startAI, true);
            return { provider: 'openai', error: err.message };
        })
    );

    // Ollama Task
    promises.push(
        ollamaEmbedClient.embeddings.create({
            model: EMBEDDING_MODEL_OLLAMA,
            input: content
        })
        .then(resp => {
            monitor.logAIRequestWithCost('embeddings', 'ollama', EMBEDDING_MODEL_OLLAMA, 0, 0, 0, Date.now() - startAI, false);
            return { provider: 'ollama', data: resp.data[0].embedding };
        })
        .catch(err => {
            monitor.logAIRequestWithCost('embeddings', 'ollama', EMBEDDING_MODEL_OLLAMA, 0, 0, 0, Date.now() - startAI, true);
            return { provider: 'ollama', error: err.message };
        })
    );

    const results = await Promise.allSettled(promises);

    for (const res of results) {
        if (res.status === 'fulfilled') {
            const val = res.value as any;
            if (!val.error) {
                insertKnowledgeFragment(
                    campaignId, sessionId, content,
                    val.data,
                    val.provider === 'openai' ? EMBEDDING_MODEL_OPENAI : EMBEDDING_MODEL_OLLAMA,
                    0, null, null,
                    ['MONDO', 'LORE', 'STORIA']
                );
            }
        }
    }
}

/**
 * Indicizza un oggetto importante nel RAG per ricerche future.
 * Es. "Spada delle Anime (+2 ATK, -1 HP maledizione)"
 */
export async function ingestLootEvent(
    campaignId: number,
    sessionId: string,
    itemDescription: string
) {
    // Formato strutturato per il RAG
    const content = `OGGETTO OTTENUTO: ${itemDescription}. Acquisito nella sessione corrente.`;
    
    console.log(`[RAG] 💎 Indicizzazione oggetto: ${itemDescription.substring(0, 40)}...`);

    const promises: any[] = [];
    const startAI = Date.now();

    // OpenAI Embedding
    promises.push(
        openaiEmbedClient.embeddings.create({
            model: EMBEDDING_MODEL_OPENAI,
            input: content
        })
        .then(resp => {
            const inputTokens = resp.usage?.prompt_tokens || 0;
            monitor.logAIRequestWithCost(
                'embeddings',
                'openai',
                EMBEDDING_MODEL_OPENAI,
                inputTokens, 0, 0,
                Date.now() - startAI,
                false
            );
            return { provider: 'openai', data: resp.data[0].embedding };
        })
        .catch(err => {
            monitor.logAIRequestWithCost(
                'embeddings',
                'openai',
                EMBEDDING_MODEL_OPENAI,
                0, 0, 0,
                Date.now() - startAI,
                true
            );
            return { provider: 'openai', error: err.message };
        })
    );

    // Ollama Embedding
    promises.push(
        ollamaEmbedClient.embeddings.create({
            model: EMBEDDING_MODEL_OLLAMA,
            input: content
        })
        .then(resp => {
            monitor.logAIRequestWithCost(
                'embeddings',
                'ollama',
                EMBEDDING_MODEL_OLLAMA,
                0, 0, 0,
                Date.now() - startAI,
                false
            );
            return { provider: 'ollama', data: resp.data[0].embedding };
        })
        .catch(err => {
            monitor.logAIRequestWithCost(
                'embeddings',
                'ollama',
                EMBEDDING_MODEL_OLLAMA,
                0, 0, 0,
                Date.now() - startAI,
                true
            );
            return { provider: 'ollama', error: err.message };
        })
    );

    const results = await Promise.allSettled(promises);

    // Salva entrambi gli embedding se riusciti
    for (const res of results) {
        if (res.status === 'fulfilled') {
            const val = res.value as any;
            if (!val.error) {
                insertKnowledgeFragment(
                    campaignId,
                    sessionId,
                    content,
                    val.data, // embedding vector
                    val.provider === 'openai' ? EMBEDDING_MODEL_OPENAI : EMBEDDING_MODEL_OLLAMA,
                    Date.now(), // timestamp
                    null, // macro location (potrebbe essere utile se vuoi tracciare DOVE l'hanno trovato)
                    'INVENTARIO', // micro location speciale per filtrare
                    ['LOOT'] // NPC associati → usiamo come tag speciale
                );
            }
        }
    }
}
