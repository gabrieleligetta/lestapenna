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
    getNewCharacterHistory,
    updateCharacterLastSyncedHistoryId,
    getNpcHistory,
    getCampaignSnapshot,
    getSessionTravelLog,
    getSessionEncounteredNPCs,
    getExplicitSessionNumber,
    db,
    getOpenQuests,
    getNpcEntry,
    updateNpcEntry,
    deleteNpcRagSummary,
    getDirtyNpcs,
    clearNpcDirtyFlag,
    // Atlas dirty sync
    getAtlasEntryFull,
    deleteAtlasRagSummary,
    getDirtyAtlasEntries,
    clearAtlasDirtyFlag,
    AtlasEntryFull,
    // Timeline dirty sync
    getDirtyWorldEvents,
    clearWorldEventDirtyFlag,
    WorldEventFull,
    // Character dirty sync
    markCharacterDirty,
    clearCharacterDirtyFlag,
    getDirtyCharacters,
    // Sistema Ibrido RAG (ID + Alias)
    getNpcIdByName,
    getNpcByNameOrAlias,
    // 🆕 Sistema Entity Refs
    createEntityRef,
    parseEntityRefs,
    filterEntityRefsByType,
    migrateOldNpcIds,
    listAtlasEntries,
    // 🆕 Static imports for reconciliation
    listAllAtlasEntries,
    listAllMonsters,
    listAllInventory,
    listAllQuests
} from './db';
import { monitor } from './monitor';
import { processChronologicalSession, safeJsonParse } from './transcriptUtils';
import { filterWhisperHallucinations } from './whisperHallucinationFilter';
// NarrativeFilter rimosso - ora usiamo solo pulizia regex

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
            timeout: 1800 * 1000, // 30 minuti (per batch NarrativeFilter grandi)
        });
    }

    return new OpenAI({
        apiKey: process.env.OPENAI_API_KEY || 'dummy',
        project: process.env.OPENAI_PROJECT_ID,
        timeout: 1800 * 1000, // 30 minuti
    });
}

// ============================================
// PROVIDER CONFIGURATION (Per-Phase)
// ============================================

const TRANSCRIPTION_PROVIDER = getProvider('TRANSCRIPTION_PROVIDER', 'AI_PROVIDER');
const METADATA_PROVIDER = getProvider('METADATA_PROVIDER', 'AI_PROVIDER');
const MAP_PROVIDER = getProvider('MAP_PROVIDER', 'AI_PROVIDER');
const SUMMARY_PROVIDER = getProvider('SUMMARY_PROVIDER', 'AI_PROVIDER');
const ANALYST_PROVIDER = getProvider('ANALYST_PROVIDER', 'METADATA_PROVIDER'); // Estrazione dati strutturati (fallback su Metadata)
const CHAT_PROVIDER = getProvider('CHAT_PROVIDER', 'AI_PROVIDER');
const EMBEDDING_PROVIDER = getProvider('EMBEDDING_PROVIDER', 'AI_PROVIDER');
const NARRATIVE_FILTER_PROVIDER = getProvider('NARRATIVE_FILTER_PROVIDER', 'AI_PROVIDER');

// ============================================
// MODEL CONFIGURATION (Per-Phase)
// ============================================

const TRANSCRIPTION_MODEL = getModel(TRANSCRIPTION_PROVIDER, 'OPEN_AI_MODEL_TRANSCRIPTION', 'gpt-5-nano');
const METADATA_MODEL = getModel(METADATA_PROVIDER, 'OPEN_AI_MODEL_METADATA', 'gpt-5-mini');
const MAP_MODEL = getModel(MAP_PROVIDER, 'OPEN_AI_MODEL_MAP', 'gpt-5-mini');
const SUMMARY_MODEL = getModel(SUMMARY_PROVIDER, 'OPEN_AI_MODEL_SUMMARY', 'gpt-5.2');
const ANALYST_MODEL = getModel(ANALYST_PROVIDER, 'OPEN_AI_MODEL_METADATA', 'gpt-5-mini'); // Modello economico per dati
const CHAT_MODEL = getModel(CHAT_PROVIDER, 'OPEN_AI_MODEL_CHAT', 'gpt-5-mini');
const NARRATIVE_FILTER_MODEL = getModel(NARRATIVE_FILTER_PROVIDER, 'OPEN_AI_MODEL_NARRATIVE_FILTER', 'gpt-5-mini');

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
const analystClient = createClient(ANALYST_PROVIDER); // Per estrazione dati strutturati
const chatClient = createClient(CHAT_PROVIDER);
const narrativeFilterClient = createClient(NARRATIVE_FILTER_PROVIDER);

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
const NARRATIVE_BATCH_SIZE = parseInt(process.env.NARRATIVE_BATCH_SIZE || '30', 10);

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
console.log(`Analyst:     ${ANALYST_PROVIDER.padEnd(8)} → ${ANALYST_MODEL.padEnd(20)} (estrazione dati)`);
console.log(`Summary:     ${SUMMARY_PROVIDER.padEnd(8)} → ${SUMMARY_MODEL.padEnd(20)} (narrazione)`);
console.log(`Chat/RAG:    ${CHAT_PROVIDER.padEnd(8)} → ${CHAT_MODEL.padEnd(20)}`);
console.log(`NarrFilter:  ${NARRATIVE_FILTER_PROVIDER.padEnd(8)} → ${NARRATIVE_FILTER_MODEL.padEnd(20)} (batch: ${NARRATIVE_BATCH_SIZE})`);
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
    narrativeBrief?: string;
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
    monsters?: Array<{
        name: string;
        status: string;
        count?: string;
        description?: string;
        abilities?: string[];
        weaknesses?: string[];
        resistances?: string[];
    }>;

    // 🆕 METADATI ESTRATTI (Architettura Unificata)
    npc_dossier_updates?: Array<{
        name: string;
        description: string;
        role?: string;
        status?: 'ALIVE' | 'DEAD' | 'MISSING';
    }>;
    location_updates?: Array<{
        macro: string;
        micro: string;
        description: string;
    }>;
    // 🆕 TRAVEL SEQUENCE: Sequenza cronologica dei luoghi visitati (per tracking GPS)
    travel_sequence?: Array<{
        macro: string;
        micro: string;
        reason?: string; // Motivo dello spostamento (opzionale)
    }>;
    present_npcs?: string[];

    session_data?: {
        travels: Array<{
            timestamp: number;
            macro_location: string | null;
            micro_location: string | null;
        }>;
        encountered_npcs: Array<{
            name: string;
            role: string | null;
            status: string;
            description: string | null;
        }>;
        campaign_info: {
            name: string;
            session_number: string | number;
            session_date: string;
        };
    };
}

// ============================================
// SISTEMA ARMONICO: INTERFACCE VALIDAZIONE
// ============================================

interface ValidationBatchInput {
    npc_events?: Array<{ name: string; event: string; type: string }>;
    character_events?: Array<{ name: string; event: string; type: string }>;
    world_events?: Array<{ event: string; type: string }>;
    loot?: string[];
    quests?: string[];
    atlas_update?: {
        macro: string;
        micro: string;
        description: string;
        existingDesc?: string;
    };
}

interface ValidationBatchOutput {
    npc_events: { keep: any[]; skip: string[] };
    character_events: { keep: any[]; skip: string[] };
    world_events: { keep: any[]; skip: string[] };
    loot: { keep: string[]; skip: string[] };
    quests: { keep: string[]; skip: string[] };
    atlas: { action: 'keep' | 'skip' | 'merge'; text?: string };
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

// ============================================
// SISTEMA ARMONICO: VALIDAZIONE BATCH
// ============================================

/**
 * Costruisce il prompt per la validazione batch
 */
function buildValidationPrompt(context: any, input: ValidationBatchInput): string {
    let prompt = `Valida questi dati di una sessione D&D in BATCH.

**CONTESTO:**
`;

    // Aggiungi contesto NPC
    if (context.npcHistories && Object.keys(context.npcHistories).length > 0) {
        prompt += "\n**Storia Recente NPC:**\n";
        for (const [name, history] of Object.entries(context.npcHistories)) {
            prompt += `- ${name}: ${history}\n`;
        }
    }

    // Aggiungi contesto PG
    if (context.charHistories && Object.keys(context.charHistories).length > 0) {
        prompt += "\n**Storia Recente PG:**\n";
        for (const [name, history] of Object.entries(context.charHistories)) {
            prompt += `- ${name}: ${history}\n`;
        }
    }

    // Aggiungi quest attive
    if (context.existingQuests && context.existingQuests.length > 0) {
        prompt += `\n**Quest Attive (DA NON DUPLICARE):**\n${context.existingQuests.map((q: string) => `- ${q}`).join('\n')}\n`;
    }

    prompt += "\n**DATI DA VALIDARE:**\n\n";

    // Eventi NPC
    if (input.npc_events && input.npc_events.length > 0) {
        prompt += `**Eventi NPC (${input.npc_events.length}):**\n`;
        input.npc_events.forEach((e, i) => {
            prompt += `${i + 1}. ${e.name}: [${e.type}] ${e.event}\n`;
        });
        prompt += "\n";
    }

    // Eventi PG
    if (input.character_events && input.character_events.length > 0) {
        prompt += `**Eventi PG (${input.character_events.length}):**\n`;
        input.character_events.forEach((e, i) => {
            prompt += `${i + 1}. ${e.name}: [${e.type}] ${e.event}\n`;
        });
        prompt += "\n";
    }

    // Eventi Mondo
    if (input.world_events && input.world_events.length > 0) {
        prompt += `**Eventi Mondo (${input.world_events.length}):**\n`;
        input.world_events.forEach((e, i) => {
            prompt += `${i + 1}. [${e.type}] ${e.event}\n`;
        });
        prompt += "\n";
    }

    // Loot
    if (input.loot && input.loot.length > 0) {
        prompt += `**Loot (${input.loot.length}):**\n`;
        input.loot.forEach((item, i) => prompt += `${i + 1}. ${item}\n`);
        prompt += "\n";
    }

    // Quest
    if (input.quests && input.quests.length > 0) {
        prompt += `**Quest (${input.quests.length}):**\n`;
        input.quests.forEach((q, i) => prompt += `${i + 1}. ${q}\n`);
        prompt += "\n";
    }

    // Atlante
    if (input.atlas_update) {
        const a = input.atlas_update;
        prompt += `**Aggiornamento Atlante:**\n`;
        prompt += `- Luogo: ${a.macro} - ${a.micro}\n`;
        if (a.existingDesc) {
            const truncDesc = a.existingDesc.length > 200 ? a.existingDesc.substring(0, 200) + '...' : a.existingDesc;
            prompt += `- Descrizione Esistente: ${truncDesc}\n`;
        }
        prompt += `- Nuova Descrizione: ${a.description}\n\n`;
    }

    prompt += `
**REGOLE DI VALIDAZIONE:**

**Eventi (NPC/PG/World):**
- SKIP se: duplicato semantico della storia recente, evento banale (es. "ha parlato", "ha mangiato"), contraddittorio con eventi recenti
- KEEP se: cambio di status significativo, rivelazione importante, impatto sulla trama
- Per eventi KEEP: riscrivi in modo conciso (max 1 frase chiara)

**Loot:**
- SKIP: spazzatura (<10 monete di valore stimato), oggetti di scena non utilizzabili (es. "sacco vuoto"), duplicati semantici
- KEEP: oggetti magici o unici (anche se sembrano deboli), valuta >=10 monete, oggetti chiave per la trama
- Normalizza nomi: "Spada +1" invece di "lama affilata magica"
- Aggrega valuta: "150 mo" invece di liste multiple

**Quest:**
- **CRITICO**: Confronta OGNI quest di input con la lista "Quest Attive" nel contesto.
- Se esiste già una quest con significato simile (es. "Uccidere Drago" vs "Sconfiggere il Drago"), **SKIP**.
- Se l'input include stati come "(Completata)", "(In corso)", ignorali per il confronto semantico.
- Mantieni SOLO le quest che sono *veramente* nuove (mai viste prima).
- Normalizza: rimuovi prefissi come "Quest:", "TODO:", capitalizza correttamente

**Atlante:**
- SKIP se: e' solo una riformulazione generica dello stesso contenuto, e' piu' generica e perde dettagli
- MERGE se: contiene nuovi dettagli osservabili E preserva informazioni storiche esistenti
- KEEP se: e' la prima descrizione del luogo (non c'e' descrizione esistente)
- Per MERGE: restituisci descrizione unificata che preserva vecchi dettagli + aggiunge novita'

**OUTPUT JSON RICHIESTO:**
{
  "npc_events": {
    "keep": [{"name": "NomeNPC", "event": "evento riscritto conciso", "type": "TIPO"}],
    "skip": ["motivo scarto 1", "motivo scarto 2"]
  },
  "character_events": {
    "keep": [{"name": "NomePG", "event": "evento riscritto", "type": "TIPO"}],
    "skip": ["motivo"]
  },
  "world_events": {
    "keep": [{"event": "evento riscritto", "type": "TIPO"}],
    "skip": ["motivo"]
  },
  "loot": {
    "keep": ["Spada +1", "150 mo"],
    "skip": ["frecce rotte - valore <10mo"]
  },
  "quests": {
    "keep": ["Recuperare la Spada del Destino"],
    "skip": ["parlare con oste - micro-task", "duplicato di quest attiva"]
  },
  "atlas": {
    "action": "keep" | "skip" | "merge",
    "text": "descrizione unificata se action=merge, altrimenti ometti"
  }
}

Rispondi SOLO con il JSON, niente altro.`;

    return prompt;
}

/**
 * VALIDATORE BATCH UNIFICATO - Ottimizzato per costi
 * Usa 1 sola chiamata AI invece di 6 separate
 */
export async function validateBatch(
    campaignId: number,
    input: ValidationBatchInput
): Promise<ValidationBatchOutput> {

    // Recupera contesto solo se necessario
    const context: any = {};

    // Context NPC (solo ultimi 3 eventi per NPC)
    if (input.npc_events && input.npc_events.length > 0) {
        const npcNames = [...new Set(input.npc_events.map(e => e.name))];
        context.npcHistories = {};

        for (const name of npcNames) {
            const history = getNpcHistory(campaignId, name).slice(-10);
            if (history.length > 0) {
                context.npcHistories[name] = history.map((h: any) =>
                    `[${h.event_type}] ${h.description}`
                ).join('; ');
            }
        }
    }

    // Context PG
    if (input.character_events && input.character_events.length > 0) {
        const charNames = [...new Set(input.character_events.map(e => e.name))];
        context.charHistories = {};

        for (const name of charNames) {
            const history = getCharacterHistory(campaignId, name).slice(-3);
            if (history.length > 0) {
                context.charHistories[name] = history.map((h: any) =>
                    `[${h.event_type}] ${h.description}`
                ).join('; ');
            }
        }
    }

    // Context Quest
    if (input.quests && input.quests.length > 0) {
        context.existingQuests = getOpenQuests(campaignId).map((q: any) => q.title);
    }

    // Costruisci prompt ottimizzato
    const prompt = buildValidationPrompt(context, input);

    const startAI = Date.now();
    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [
                { role: "system", content: "Sei il Custode degli Archivi di una campagna D&D. Valida dati in batch. Rispondi SOLO con JSON valido in italiano." },
                { role: "user", content: prompt }
            ],
            response_format: { type: "json_object" }
        });

        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;

        monitor.logAIRequestWithCost('metadata', METADATA_PROVIDER, METADATA_MODEL, inputTokens, outputTokens, cachedTokens, latency, false);

        console.log(`[Validator] Validazione completata in ${latency}ms (${inputTokens}+${outputTokens} tokens)`);

        const result = JSON.parse(response.choices[0].message.content || "{}");

        // Fallback sicuro per ogni campo
        return {
            npc_events: result.npc_events || { keep: input.npc_events || [], skip: [] },
            character_events: result.character_events || { keep: input.character_events || [], skip: [] },
            world_events: result.world_events || { keep: input.world_events || [], skip: [] },
            loot: result.loot || { keep: input.loot || [], skip: [] },
            quests: result.quests || { keep: input.quests || [], skip: [] },
            atlas: result.atlas || { action: 'keep' }
        };

    } catch (e: any) {
        console.error('[Validator] Errore batch validation:', e);
        monitor.logAIRequestWithCost('metadata', METADATA_PROVIDER, METADATA_MODEL, 0, 0, 0, Date.now() - startAI, true);

        // Fallback conservativo: accetta tutto
        return {
            npc_events: { keep: input.npc_events || [], skip: [] },
            character_events: { keep: input.character_events || [], skip: [] },
            world_events: { keep: input.world_events || [], skip: [] },
            loot: { keep: input.loot || [], skip: [] },
            quests: { keep: input.quests || [], skip: [] },
            atlas: { action: 'keep' }
        };
    }
}

/**
 * Ingestion generica nel RAG (per snapshot autorevoli)
 */
async function ingestGenericEvent(
    campaignId: number,
    sessionId: string,
    content: string,
    npcs: string[],
    microLoc: string
): Promise<void> {
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
                monitor.logAIRequestWithCost('embeddings', 'openai', EMBEDDING_MODEL_OPENAI, inputTokens, 0, 0, Date.now() - startAI, false);
                return { provider: 'openai', data: resp.data[0].embedding };
            })
            .catch(err => {
                console.error('[RAG] Errore embedding OpenAI:', err.message);
                monitor.logAIRequestWithCost('embeddings', 'openai', EMBEDDING_MODEL_OPENAI, 0, 0, 0, Date.now() - startAI, true);
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
                monitor.logAIRequestWithCost('embeddings', 'ollama', EMBEDDING_MODEL_OLLAMA, 0, 0, 0, Date.now() - startAI, false);
                return { provider: 'ollama', data: resp.data[0].embedding };
            })
            .catch(err => {
                console.error('[RAG] Errore embedding Ollama:', err.message);
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
                    campaignId,
                    sessionId,
                    content,
                    val.data,
                    val.provider === 'openai' ? EMBEDDING_MODEL_OPENAI : EMBEDDING_MODEL_OLLAMA,
                    Date.now(),
                    null,
                    microLoc,
                    npcs
                );
            }
        }
    }

    console.log(`[RAG] Evento generico indicizzato in ${Date.now() - startAI}ms`);
}

/**
 * Sincronizza NPC Dossier (LAZY - solo se necessario)
 */
export async function syncNpcDossierIfNeeded(
    campaignId: number,
    npcName: string,
    force: boolean = false
): Promise<string | null> {

    const npc = getNpcEntry(campaignId, npcName);
    if (!npc) return null;

    // Check se necessita sync (usa any per evitare errore TS su campo opzionale)
    const needsSync = (npc as any).rag_sync_needed === 1;
    if (!force && !needsSync) {
        console.log(`[Sync] ${npcName} gia sincronizzato, skip.`);
        return npc.description;
    }

    console.log(`[Sync] Avvio sync per ${npcName}...`);

    // Rigenera biografia
    const newBio = await regenerateNpcNotes(
        campaignId,
        npcName,
        npc.role || 'Sconosciuto',
        npc.description || ''
    );

    // Aggiorna SQL
    updateNpcEntry(campaignId, npcName, newBio, npc.role || undefined);

    // Pulisci vecchi snapshot RAG
    deleteNpcRagSummary(campaignId, npcName);

    // Crea nuovo snapshot (SOLO se bio significativa)
    if (newBio.length > 100) {
        const ragContent = `[[SCHEDA UFFICIALE: ${npcName}]]
RUOLO: ${npc.role || 'Sconosciuto'}
STATO: ${npc.status || 'Sconosciuto'}
BIOGRAFIA COMPLETA: ${newBio}

(Questa scheda ufficiale ha priorita su informazioni frammentarie precedenti)`;

        await ingestGenericEvent(
            campaignId,
            'DOSSIER_UPDATE',
            ragContent,
            [npcName],
            'DOSSIER'
        );
    }

    // Marca come pulito
    clearNpcDirtyFlag(campaignId, npcName);

    console.log(`[Sync] ${npcName} sincronizzato.`);
    return newBio;
}

/**
 * Batch sync di tutti gli NPC dirty
 */
export async function syncAllDirtyNpcs(campaignId: number): Promise<number> {
    const dirtyNpcs = getDirtyNpcs(campaignId);

    if (dirtyNpcs.length === 0) {
        console.log('[Sync] Nessun NPC da sincronizzare.');
        return 0;
    }

    console.log(`[Sync] Sincronizzazione batch di ${dirtyNpcs.length} NPC...`);

    for (const npc of dirtyNpcs) {
        try {
            await syncNpcDossierIfNeeded(campaignId, npc.name, true);
        } catch (e) {
            console.error(`[Sync] Errore sync ${npc.name}:`, e);
        }
    }

    return dirtyNpcs.length;
}

// --- ATLAS SYNC FUNCTIONS ---

/**
 * Sincronizza una voce Atlas nel RAG (LAZY - solo se necessario)
 */
export async function syncAtlasEntryIfNeeded(
    campaignId: number,
    macro: string,
    micro: string,
    force: boolean = false
): Promise<string | null> {

    const entry = getAtlasEntryFull(campaignId, macro, micro);
    if (!entry) return null;

    // Check se necessita sync
    const needsSync = (entry as any).rag_sync_needed === 1;
    if (!force && !needsSync) {
        console.log(`[Sync Atlas] ${macro} - ${micro} gia sincronizzato, skip.`);
        return entry.description;
    }

    console.log(`[Sync Atlas] Avvio sync per ${macro} - ${micro}...`);

    // Pulisci vecchi snapshot RAG
    deleteAtlasRagSummary(campaignId, macro, micro);

    // Crea nuovo snapshot (SOLO se descrizione significativa)
    if (entry.description && entry.description.length > 50) {
        const locationKey = `${macro}|${micro}`;
        const ragContent = `[[SCHEDA LUOGO UFFICIALE: ${macro} - ${micro}]]
MACRO REGIONE: ${macro}
LUOGO SPECIFICO: ${micro}
DESCRIZIONE COMPLETA: ${entry.description}
CHIAVE: ${locationKey}

(Questa scheda ufficiale del luogo ha priorita su informazioni frammentarie precedenti)`;

        await ingestGenericEvent(
            campaignId,
            'ATLAS_UPDATE',
            ragContent,
            [],
            'ATLAS'
        );
    }

    // Marca come pulito
    clearAtlasDirtyFlag(campaignId, macro, micro);

    console.log(`[Sync Atlas] ${macro} - ${micro} sincronizzato.`);
    return entry.description;
}

/**
 * Batch sync di tutti i luoghi dirty
 */
export async function syncAllDirtyAtlas(campaignId: number): Promise<number> {
    const dirtyEntries = getDirtyAtlasEntries(campaignId);

    if (dirtyEntries.length === 0) {
        console.log('[Sync Atlas] Nessun luogo da sincronizzare.');
        return 0;
    }

    console.log(`[Sync Atlas] Sincronizzazione batch di ${dirtyEntries.length} luoghi...`);

    for (const entry of dirtyEntries) {
        try {
            await syncAtlasEntryIfNeeded(campaignId, entry.macro_location, entry.micro_location, true);
        } catch (e) {
            console.error(`[Sync Atlas] Errore sync ${entry.macro_location} - ${entry.micro_location}:`, e);
        }
    }

    return dirtyEntries.length;
}

// --- TIMELINE SYNC FUNCTIONS ---

/**
 * Batch sync di tutti gli eventi timeline dirty
 */
export async function syncAllDirtyTimeline(campaignId: number): Promise<number> {
    const dirtyEvents = getDirtyWorldEvents(campaignId);

    if (dirtyEvents.length === 0) {
        console.log('[Sync Timeline] Nessun evento da sincronizzare.');
        return 0;
    }

    console.log(`[Sync Timeline] Sincronizzazione batch di ${dirtyEvents.length} eventi...`);

    for (const evt of dirtyEvents) {
        try {
            // Usa ingestWorldEvent per creare l'embedding
            // Nota: ingestWorldEvent non controlla duplicati, ma dato che è un evento nuovo (dirty), va bene.
            // Se stiamo ri-sincronizzando, potremmo voler pulire prima, ma per ora assumiamo append-only.
            // Per sicurezza, potremmo cancellare vecchi embedding con lo stesso contenuto esatto se necessario,
            // ma ingestWorldEvent è stateless.

            await ingestWorldEvent(campaignId, evt.session_id || 'MANUAL_ENTRY', evt.description, evt.event_type);

            // Marca come pulito
            clearWorldEventDirtyFlag(evt.id);

        } catch (e) {
            console.error(`[Sync Timeline] Errore sync evento #${evt.id}:`, e);
        }
    }

    return dirtyEvents.length;
}

// --- CHARACTER SYNC FUNCTIONS ---

/**
 * Rigenera la descrizione di un personaggio giocante basandosi su NUOVI eventi.
 * Rispetta l'agency del giocatore: modifica solo conseguenze osservabili, non personalità.
 * @param newEvents - Solo gli eventi NON ancora integrati nella biografia
 */
export async function regenerateCharacterDescription(
    charName: string,
    currentDesc: string,
    newEvents: Array<{ description: string, event_type: string }>
): Promise<string> {
    if (newEvents.length === 0) {
        console.log(`[Character] Nessun nuovo evento per ${charName}, mantengo descrizione attuale.`);
        return currentDesc;
    }

    const historyText = newEvents
        .slice(-10) // Max 10 eventi nuovi
        .map(h => `[${h.event_type}] ${h.description}`)
        .join('\n');

    const prompt = `Sei il Biografo Personale del personaggio giocante **${charName}**.

**BIOGRAFIA ATTUALE (Contiene già eventi precedenti integrati):**
${currentDesc || 'Nessuna descrizione iniziale.'}

**NUOVI EVENTI DA INTEGRARE (Non ancora nella biografia sopra):**
${historyText}

**REGOLE CRITICHE:**
1. **NON DUPLICARE**: Gli eventi nella "Biografia Attuale" sono GIÀ integrati. Aggiungi SOLO i "Nuovi Eventi".
2. **Rispetta l'Agency del Giocatore**: NON cambiare tratti di personalità.
3. **Aggiungi Solo Conseguenze Osservabili**: Cicatrici, oggetti iconici, titoli, relazioni chiave.
4. **Preserva il Testo Esistente**: Modifica minimamente, aggiungi max 1-2 frasi per i nuovi eventi.
5. **Formato**: Terza persona, stile enciclopedia fantasy, max 800 caratteri totali.

Restituisci SOLO il testo aggiornato della biografia (senza introduzioni o spiegazioni).`;

    const startAI = Date.now();
    try {
        const response = await summaryClient.chat.completions.create({
            model: SUMMARY_MODEL,
            messages: [
                { role: "system", content: "Sei un biografo esperto. Integra SOLO i nuovi eventi senza duplicare quelli già presenti. Max 800 caratteri." },
                { role: "user", content: prompt }
            ],
            max_completion_tokens: 300
        });

        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, inputTokens, outputTokens, 0, latency, false);

        const newDesc = response.choices[0].message.content?.trim() || currentDesc;
        console.log(`[Character] Biografia aggiornata per ${charName} (+${newEvents.length} eventi, ${latency}ms)`);

        return newDesc;

    } catch (e) {
        console.error(`[Character] Errore rigenerazione ${charName}:`, e);
        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, 0, 0, 0, Date.now() - startAI, true);
        return currentDesc;
    }
}

/**
 * Sincronizza un personaggio giocante nel RAG (LAZY - solo se necessario)
 * Usa tracking intelligente per evitare di duplicare eventi già integrati.
 */
export async function syncCharacterIfNeeded(
    campaignId: number,
    userId: string,
    force: boolean = false
): Promise<string | null> {
    const char = db.prepare(`
        SELECT character_name, description, rag_sync_needed, last_synced_history_id
        FROM characters
        WHERE user_id = ? AND campaign_id = ?
    `).get(userId, campaignId) as {
        character_name: string,
        description: string | null,
        rag_sync_needed: number,
        last_synced_history_id: number
    } | undefined;

    if (!char || !char.character_name) return null;

    // Controlla flag auto-update della campagna
    const campaign = getCampaignById(campaignId);
    if (!force && !campaign?.allow_auto_character_update) {
        console.log(`[Sync Character] Auto-update PG disabilitato per campagna ${campaignId}.`);
        return char.description;
    }

    // Check se necessita sync
    const needsSync = char.rag_sync_needed === 1;
    if (!force && !needsSync) {
        console.log(`[Sync Character] ${char.character_name} già sincronizzato, skip.`);
        return char.description;
    }

    // Recupera SOLO gli eventi nuovi (non ancora integrati)
    const lastSyncedId = char.last_synced_history_id || 0;
    const { events: newEvents, maxId } = getNewCharacterHistory(campaignId, char.character_name, lastSyncedId);

    if (newEvents.length === 0) {
        console.log(`[Sync Character] ${char.character_name}: nessun nuovo evento da integrare (lastSync: ${lastSyncedId}).`);
        // Reset flag anche se non ci sono nuovi eventi
        db.prepare(`UPDATE characters SET rag_sync_needed = 0 WHERE user_id = ? AND campaign_id = ?`).run(userId, campaignId);
        return char.description;
    }

    console.log(`[Sync Character] Avvio sync per ${char.character_name} (+${newEvents.length} nuovi eventi, lastSync: ${lastSyncedId} → ${maxId})...`);

    // Rigenera descrizione con SOLO gli eventi nuovi
    const newDesc = await regenerateCharacterDescription(
        char.character_name,
        char.description || '',
        newEvents
    );

    // Aggiorna SQL con nuova descrizione e tracking
    db.prepare(`
        UPDATE characters
        SET description = ?, rag_sync_needed = 0, last_synced_history_id = ?
        WHERE user_id = ? AND campaign_id = ?
    `).run(newDesc, maxId, userId, campaignId);

    // Pulisci vecchi snapshot RAG
    db.prepare(`
        DELETE FROM knowledge_fragments
        WHERE session_id = 'CHARACTER_UPDATE'
          AND associated_npcs LIKE ?
    `).run(`%${char.character_name}%`);

    // Crea nuovo snapshot RAG (solo se descrizione significativa)
    if (newDesc.length > 100) {
        const ragContent = `[[SCHEDA PERSONAGGIO GIOCANTE: ${char.character_name}]]
DESCRIZIONE AGGIORNATA: ${newDesc}

(Questa scheda ufficiale del PG ha priorità su informazioni frammentarie precedenti)`;

        await ingestGenericEvent(
            campaignId,
            'CHARACTER_UPDATE',
            ragContent,
            [char.character_name],
            'PARTY'
        );
    }

    console.log(`[Sync Character] ${char.character_name} sincronizzato (lastSyncedHistoryId: ${maxId}).`);
    return newDesc;
}

/**
 * RESET e rigenera la biografia di un PG da zero.
 * Usa TUTTI gli eventi dalla character_history, ignorando il tracking precedente.
 */
export async function resetAndRegenerateCharacterBio(
    campaignId: number,
    userId: string
): Promise<string | null> {
    const char = db.prepare(`
        SELECT character_name, description
        FROM characters
        WHERE user_id = ? AND campaign_id = ?
    `).get(userId, campaignId) as { character_name: string, description: string | null } | undefined;

    if (!char || !char.character_name) return null;

    // Recupera TUTTI gli eventi (ignora last_synced_history_id)
    const allEvents = getCharacterHistory(campaignId, char.character_name);

    if (allEvents.length === 0) {
        console.log(`[Character Reset] ${char.character_name}: nessun evento in history, reset a vuoto.`);
        db.prepare(`
            UPDATE characters
            SET description = '', last_synced_history_id = 0, rag_sync_needed = 0
            WHERE user_id = ? AND campaign_id = ?
        `).run(userId, campaignId);
        return '';
    }

    // Trova il maxId per aggiornare il tracking
    const maxIdResult = db.prepare(`
        SELECT MAX(id) as maxId FROM character_history
        WHERE campaign_id = ? AND lower(character_name) = lower(?)
    `).get(campaignId, char.character_name) as { maxId: number } | undefined;
    const maxId = maxIdResult?.maxId || 0;

    console.log(`[Character Reset] Rigenerazione completa per ${char.character_name} (${allEvents.length} eventi totali)...`);

    // Rigenera da zero (descrizione vuota + tutti gli eventi)
    const newDesc = await regenerateCharacterDescription(
        char.character_name,
        '', // Descrizione vuota - rigenera tutto da zero
        allEvents
    );

    // Aggiorna SQL
    db.prepare(`
        UPDATE characters
        SET description = ?, last_synced_history_id = ?, rag_sync_needed = 0
        WHERE user_id = ? AND campaign_id = ?
    `).run(newDesc, maxId, userId, campaignId);

    // Pulisci e ricrea snapshot RAG
    db.prepare(`
        DELETE FROM knowledge_fragments
        WHERE session_id = 'CHARACTER_UPDATE'
          AND associated_npcs LIKE ?
    `).run(`%${char.character_name}%`);

    if (newDesc.length > 100) {
        const ragContent = `[[SCHEDA PERSONAGGIO GIOCANTE: ${char.character_name}]]
DESCRIZIONE AGGIORNATA: ${newDesc}

(Questa scheda ufficiale del PG ha priorità su informazioni frammentarie precedenti)`;

        await ingestGenericEvent(
            campaignId,
            'CHARACTER_UPDATE',
            ragContent,
            [char.character_name],
            'PARTY'
        );
    }

    console.log(`[Character Reset] ${char.character_name} rigenerato da zero (${allEvents.length} eventi → ${newDesc.length} chars).`);
    return newDesc;
}

/**
 * RESET e rigenera le biografie di TUTTI i PG della campagna.
 */
export async function resetAllCharacterBios(campaignId: number): Promise<{ reset: number, names: string[] }> {
    const allChars = db.prepare(`
        SELECT user_id, character_name
        FROM characters
        WHERE campaign_id = ? AND character_name IS NOT NULL
    `).all(campaignId) as { user_id: string, character_name: string }[];

    if (allChars.length === 0) {
        return { reset: 0, names: [] };
    }

    console.log(`[Character Reset] Reset batch di ${allChars.length} PG...`);
    const resetNames: string[] = [];

    for (const char of allChars) {
        try {
            const newDesc = await resetAndRegenerateCharacterBio(campaignId, char.user_id);
            if (newDesc !== null) {
                resetNames.push(char.character_name);
            }
        } catch (e) {
            console.error(`[Character Reset] Errore per ${char.character_name}:`, e);
        }
    }

    return { reset: resetNames.length, names: resetNames };
}

/**
 * Batch sync di tutti i personaggi dirty
 */
export async function syncAllDirtyCharacters(campaignId: number): Promise<{ synced: number, names: string[] }> {
    // Controlla flag auto-update della campagna
    const campaign = getCampaignById(campaignId);
    if (!campaign?.allow_auto_character_update) {
        console.log('[Sync Character] Auto-update PG disabilitato per questa campagna.');
        return { synced: 0, names: [] };
    }

    const dirtyChars = getDirtyCharacters(campaignId);

    if (dirtyChars.length === 0) {
        console.log('[Sync Character] Nessun PG da sincronizzare.');
        return { synced: 0, names: [] };
    }

    console.log(`[Sync Character] Sincronizzazione batch di ${dirtyChars.length} PG...`);

    const syncedNames: string[] = [];

    for (const char of dirtyChars) {
        try {
            const newDesc = await syncCharacterIfNeeded(campaignId, char.user_id, true);
            if (newDesc) {
                syncedNames.push(char.character_name);
            }
        } catch (e) {
            console.error(`[Sync Character] Errore sync ${char.character_name}:`, e);
        }
    }

    return { synced: syncedNames.length, names: syncedNames };
}

// --- PREPARAZIONE TESTO PULITO (per generateSummary) ---
export function prepareCleanText(sessionId: string): string | undefined {
    const campaignId = getSessionCampaignId(sessionId);
    if (!campaignId) {
        console.warn(`[Prep] ⚠️ Sessione ${sessionId} senza campagna.`);
        return undefined;
    }

    const transcriptions = getSessionTranscript(sessionId);
    const notes = getSessionNotes(sessionId);
    const startTime = getSessionStartTime(sessionId) || 0;

    if (transcriptions.length === 0 && notes.length === 0) return undefined;

    const processed = processChronologicalSession(transcriptions, notes, startTime, campaignId);

    console.log(`[Prep] 🧹 Pulizia anti-allucinazioni (${processed.segments.length} segmenti)...`);
    const cleanedSegments = processed.segments
        .map(s => ({
            ...s,
            text: filterWhisperHallucinations(s.text || '')
        }))
        .filter(s => s.text.length > 0);

    const removedCount = processed.segments.length - cleanedSegments.length;
    if (removedCount > 0) {
        console.log(`[Prep] 🗑️ Rimossi ${removedCount} segmenti vuoti/allucinazioni`);
    }

    const fullText = cleanedSegments.map(s => `[${s.character}] ${s.text}`).join('\n\n');
    console.log(`[Prep] ✅ Testo pulito: ${fullText.length} caratteri (${cleanedSegments.length} segmenti)`);

    return fullText;
}

// --- RAG: INGESTION POST-SUMMARY (usa dati Analista) ---
export async function ingestSessionComplete(
    sessionId: string,
    summaryResult: SummaryResponse
): Promise<void> {
    const campaignId = getSessionCampaignId(sessionId);
    if (!campaignId) {
        console.warn(`[RAG] ⚠️ Sessione ${sessionId} senza campagna. Salto ingestione.`);
        return;
    }

    // Usa il narrative/summary come testo principale per il RAG
    const textToIngest = summaryResult.narrative || summaryResult.summary || '';
    if (textToIngest.length < 100) {
        console.warn(`[RAG] ⚠️ Testo troppo corto per ingestione (${textToIngest.length} chars)`);
        return;
    }

    console.log(`[RAG] 🧠 Ingestione POST-SUMMARY per sessione ${sessionId}...`);
    console.log(`[RAG] 📊 Metadati Analista: ${summaryResult.present_npcs?.length || 0} NPC, ${summaryResult.location_updates?.length || 0} luoghi`);

    // 1. Pulisci vecchi frammenti per ENTRAMBI i modelli
    deleteSessionKnowledge(sessionId, EMBEDDING_MODEL_OPENAI);
    deleteSessionKnowledge(sessionId, EMBEDDING_MODEL_OLLAMA);

    const startTime = getSessionStartTime(sessionId) || Date.now();

    // 2. Prepara entity refs dagli NPC estratti dall'Analista
    const npcEntityRefs: string[] = [];
    if (summaryResult.present_npcs?.length) {
        for (const npcName of summaryResult.present_npcs) {
            const npcId = getNpcIdByName(campaignId, npcName);
            if (npcId) npcEntityRefs.push(createEntityRef('npc', npcId));
        }
    }

    // 3. Estrai location dall'Analista (usa la prima/principale)
    let mainMacro: string | null = null;
    let mainMicro: string | null = null;
    if (summaryResult.location_updates?.length) {
        mainMacro = summaryResult.location_updates[0].macro || null;
        mainMicro = summaryResult.location_updates[0].micro || null;
    }

    // 4. Sliding Window Chunking sul testo narrativo
    const CHUNK_SIZE = 1500; // Più grande perché è già prosa pulita
    const OVERLAP = 300;

    const chunks: Array<{
        text: string;
        timestamp: number;
        macro: string | null;
        micro: string | null;
        npcs: string[];
        entityRefs: string[];
    }> = [];

    let i = 0;
    while (i < textToIngest.length) {
        let end = Math.min(i + CHUNK_SIZE, textToIngest.length);
        // Trova un punto di interruzione naturale
        if (end < textToIngest.length) {
            const lastPeriod = textToIngest.lastIndexOf('.', end);
            const lastNewLine = textToIngest.lastIndexOf('\n', end);
            const breakPoint = Math.max(lastPeriod, lastNewLine);
            if (breakPoint > i + (CHUNK_SIZE * 0.5)) end = breakPoint + 1;
        }

        const chunkText = textToIngest.substring(i, end).trim();

        if (chunkText.length > 50) {
            chunks.push({
                text: chunkText,
                timestamp: startTime,
                macro: mainMacro,
                micro: mainMicro,
                npcs: summaryResult.present_npcs || [],
                entityRefs: npcEntityRefs
            });
        }

        if (end >= textToIngest.length) break;
        i = end - OVERLAP;
    }

    console.log(`[RAG] 📦 Creati ${chunks.length} chunks (${CHUNK_SIZE} chars, ${OVERLAP} overlap)`);

    // 5. Embedding con Progress Bar (DOPPIO - OpenAI + Ollama)
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
                        chunk.timestamp, chunk.macro, chunk.micro, chunk.npcs,
                        chunk.entityRefs
                    );
                }
            }
        }
    }, 'Calcolo Embeddings RAG');

    console.log(`[RAG] ✅ Ingestione completata per sessione ${sessionId}`);
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

        // 🆕 Sistema Entity Refs: Risolvi nomi e alias in entity refs
        const allNpcs = listNpcs(campaignId, 1000);
        const mentionedEntityRefs: string[] = [];

        for (const npc of allNpcs) {
            // Cerca nel nome principale
            if (query.toLowerCase().includes(npc.name.toLowerCase())) {
                mentionedEntityRefs.push(createEntityRef('npc', npc.id));
                continue;
            }

            // Cerca negli alias
            if (npc.aliases) {
                const aliases = npc.aliases.split(',').map(a => a.trim().toLowerCase());
                if (aliases.some(alias => query.toLowerCase().includes(alias))) {
                    mentionedEntityRefs.push(createEntityRef('npc', npc.id));
                }
            }
        }

        if (mentionedEntityRefs.length > 0) {
            // Estrai gli ID NPC per retrocompatibilità
            const mentionedNpcIds = filterEntityRefsByType(
                parseEntityRefs(mentionedEntityRefs.join(',')),
                'npc'
            );

            // Filtra per entity refs (priorità) o fallback su vecchi formati
            const filteredFragments = fragments.filter(f => {
                // 1. Prima prova con entity refs (nuovo formato)
                if (f.associated_entity_ids) {
                    const fragmentRefs = parseEntityRefs(f.associated_entity_ids);
                    const fragmentNpcIds = filterEntityRefsByType(fragmentRefs, 'npc');
                    if (mentionedNpcIds.some(qId => fragmentNpcIds.includes(qId))) return true;
                }

                // 2. Fallback su associated_npc_ids (formato legacy numerico)
                if (f.associated_npc_ids) {
                    // Migra on-the-fly vecchi ID se necessario
                    const migratedRefs = migrateOldNpcIds(f.associated_npc_ids);
                    if (migratedRefs) {
                        const fragmentRefs = parseEntityRefs(migratedRefs);
                        const fragmentNpcIds = filterEntityRefsByType(fragmentRefs, 'npc');
                        if (mentionedNpcIds.some(qId => fragmentNpcIds.includes(qId))) return true;
                    }
                }

                // 3. Fallback su nomi (frammenti molto vecchi)
                if (f.associated_npcs) {
                    const fragmentNpcs = f.associated_npcs.split(',').map(n => n.toLowerCase());
                    const mentionedNpcs = allNpcs.filter(npc => mentionedNpcIds.includes(npc.id));
                    return mentionedNpcs.some(mn => fragmentNpcs.includes(mn.name.toLowerCase()));
                }

                return false;
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

            // 🆕 BONUS MATCH ESATTO (Keyword Search Hybrid)
            if (query.length > 2 && f.content.toLowerCase().includes(query.toLowerCase())) {
                score += 0.5;
            }

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

// --- RAG AGENT: QUERY GENERATOR (Chat) ---
async function generateSearchQueries(campaignId: number, userQuestion: string, history: any[]): Promise<string[]> {
    const recentHistory = history.slice(-3).map(m => `${m.role}: ${m.content}`).join('\n');

    const prompt = `Sei un esperto di ricerca per un database D&D.
    
    CONTESTO CHAT RECENTE:
    ${recentHistory}
    
    ULTIMA DOMANDA UTENTE:
    "${userQuestion}"
    
    Il tuo compito è generare 1-3 query di ricerca specifiche per trovare la risposta nel database vettoriale (RAG).
    
    REGOLE:
    1. Risolvi i riferimenti (es. "Lui" -> "Leosin", "Quel posto" -> "Locanda del Drago").
    2. Usa parole chiave specifiche (Nomi, Luoghi, Oggetti).
    3. Se la domanda è generica ("Riassumi tutto"), crea query sui fatti recenti.
    
    Output: JSON array di stringhe. Es: ["Dialoghi Leosin Erantar", "Storia della Torre"]`;

    const startAI = Date.now();
    try {
        const response = await chatClient.chat.completions.create({
            model: CHAT_MODEL,
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" }
        });

        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;
        monitor.logAIRequestWithCost('chat', CHAT_PROVIDER, CHAT_MODEL, inputTokens, outputTokens, cachedTokens, Date.now() - startAI, false);

        const parsed = JSON.parse(response.choices[0].message.content || "{}");
        return Array.isArray(parsed.queries) ? parsed.queries : [];
    } catch (e) {
        monitor.logAIRequestWithCost('chat', CHAT_PROVIDER, CHAT_MODEL, 0, 0, 0, Date.now() - startAI, true);
        return [userQuestion];
    }
}

// --- ASK BARD (AGENTIC RAG) ---
export async function askBard(campaignId: number, question: string, history: { role: 'user' | 'assistant', content: string }[] = []): Promise<string> {

    // 1. AGENTIC STEP
    const searchQueries = await generateSearchQueries(campaignId, question, history);
    console.log(`[AskBard] 🧠 Query generate:`, searchQueries);

    const promises = searchQueries.map(q => searchKnowledge(campaignId, q, 3));
    const results = await Promise.all(promises);
    const uniqueContext = Array.from(new Set(results.flat()));

    let contextText = uniqueContext.length > 0
        ? "MEMORIE RECUPERATE:\n" + uniqueContext.map(c => `...\\n${c}\\n...`).join("\\n")
        : "Nessuna memoria specifica trovata.";

    const MAX_CONTEXT_CHARS = 12000;
    if (contextText.length > MAX_CONTEXT_CHARS) {
        contextText = contextText.substring(0, MAX_CONTEXT_CHARS) + "\n... [TESTO TRONCATO]";
    }

    // 2. LOGICA ATMOSFERA ORIGINALE (Preservata)
    const loc = getCampaignLocationById(campaignId);
    let atmosphere = "Sei il Bardo della campagna. Rispondi in modo neutrale ma evocativo.";

    if (loc) {
        const micro = (loc.micro || "").toLowerCase();
        const macro = (loc.macro || "").toLowerCase();

        if (micro.includes('taverna') || micro.includes('locanda') || micro.includes('pub')) {
            atmosphere = "Sei un bardo allegro e un po' brillo. Usi slang da taverna, fai battute.";
        } else if (micro.includes('cripta') || micro.includes('dungeon') || micro.includes('grotta') || micro.includes('tomba')) {
            atmosphere = "Parli sottovoce, sei teso e spaventato. Descrivi i suoni inquietanti.";
        } else if (micro.includes('tempio') || micro.includes('chiesa') || micro.includes('santuario')) {
            atmosphere = "Usi un tono solenne, rispettoso e quasi religioso.";
        } else if (macro.includes('corte') || macro.includes('castello') || macro.includes('palazzo')) {
            atmosphere = "Usi un linguaggio aulico, formale e molto rispettoso.";
        } else if (micro.includes('bosco') || micro.includes('foresta') || micro.includes('giungla')) {
            atmosphere = "Sei un bardo naturalista. Parli con meraviglia della natura.";
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
        socialContext += "Usa queste informazioni, ma dai priorità ai fatti nelle trascrizioni.\n";
    }

    const systemPrompt = `${atmosphere}
    Il tuo compito è rispondere SOLO all'ULTIMA domanda posta dal giocatore, usando le trascrizioni.
    
    ${socialContext}
    ${contextText}
    
    REGOLAMENTO RIGIDO:
    1. La cronologia serve SOLO per il contesto.
    2. NON ripetere mai le risposte già date.
    3. Rispondi in modo diretto.
    4. Se la risposta non è nelle trascrizioni, ammetti di non ricordare.`;

    const messages: any[] = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: question }];

    const startAI = Date.now();
    try {
        const response = await withRetry(() => chatClient.chat.completions.create({
            model: CHAT_MODEL,
            messages: messages as any
        }));

        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;
        monitor.logAIRequestWithCost('chat', CHAT_PROVIDER, CHAT_MODEL, inputTokens, outputTokens, cachedTokens, Date.now() - startAI, false);

        return response.choices[0].message.content || "Il Bardo è muto.";
    } catch (e) {
        console.error("[Chat] Errore:", e);
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

        // Pattern di allucinazioni note (Case Insensitive)
        const hallucinations = [
            /Autore dei.*/gi,
            /Sottotitoli.*/gi,
            /Amara\.org/gi,
            /creati dalla comunità/gi,
            /A tutti[\.,]?\s*(A tutti[\.,]?\s*)*/gi, // Cattura anche le ripetizioni
            /A te[\.,]?\s*(A te[\.,]?\s*)*/gi,
            /A voi[\.,]?\s*(A voi[\.,]?\s*)*/gi,
            /^Grazie\.?$/gi,     // Solo se isolato
            /^Mille\.?$/gi,
            /^Ciao\.?$/gi,
            /Concentrazione di Chieti/gi,
            /Noblesse anatema/gi,
            /Salomando/gi
        ];

        let cleaned = text;
        hallucinations.forEach(regex => {
            cleaned = cleaned.replace(regex, "");
        });

        return cleaned
            .replace(/\[SILENZIO\]/g, "")
            .replace(/\s+/g, " ")
            .trim();
    };

    const results = await processInBatches(
        allBatches,
        TRANSCRIPTION_CONCURRENCY,
        async (batch, idx) => {
            const prompt = `Correggi ortografia e punteggiatura in italiano.
- Rimuovi riempitivi (ehm, uhm).
- SE UNA RIGA CONTIENE SOLO "A tutti", "Autore dei", O FRASI SENZA SENSO: Scrivi "..." (tre puntini).
- NON aggiungere commenti.
- IMPORTANTE: Restituisci ESATTAMENTE ${batch.length} righe, una per riga.
- NON unire né dividere frasi.

TESTO DA CORREGGERE (${batch.length} righe):
${batch.map((s, i) => `${i + 1}. ${cleanText(s.text)}`).join('\n')}`;

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
                        console.warn(`[Correzione] ⚠️ Batch ${idx + 1}: Mismatch tollerato (${lines.length}≠${batch.length}, diff: ${diff})`);

                        // Padding o Truncate
                        return batch.map((orig, i) => ({
                            ...orig,
                            text: cleanText(lines[i] || orig.text)
                        }));
                    }

                    console.warn(`[Correzione] ⚠️ Batch ${idx + 1}: Mismatch eccessivo (${lines.length}≠${batch.length}). Uso originale.`);
                    return batch;
                }

                return batch.map((orig, i) => ({
                    ...orig,
                    text: cleanText(lines[i])
                }));

            } catch (err) {
                console.error(`[Correzione] ❌ Errore batch ${idx + 1}:`, err);
                monitor.logAIRequestWithCost('transcription', TRANSCRIPTION_PROVIDER, TRANSCRIPTION_MODEL, 0, 0, 0, Date.now() - startAI, true);
                return batch;
            }
        },
        `Correzione (${TRANSCRIPTION_PROVIDER})`
    );

    return results.flat();
}

// --- FUNZIONE PRINCIPALE REFACTORATA ---
// 🆕 ARCHITETTURA SEMPLIFICATA: Solo pulizia regex anti-allucinazioni, niente AI
export async function correctTranscription(
    segments: any[],
    campaignId?: number
): Promise<AIResponse> {
    console.log(`[Bardo] 🧹 Avvio pulizia anti-allucinazioni (${segments.length} segmenti)...`);

    // STEP UNICO: Pulizia Regex (NO AI)
    // La correzione AI è stata rimossa - il modello potente può gestire errori minori
    // L'estrazione metadati è centralizzata in generateSummary()
    const cleanedSegments = segments.map(segment => ({
        ...segment,
        text: filterWhisperHallucinations(segment.text || '')
    })).filter(segment => segment.text.length > 0); // Rimuovi segmenti vuoti

    const removedCount = segments.length - cleanedSegments.length;
    if (removedCount > 0) {
        console.log(`[Bardo] 🗑️ Rimossi ${removedCount} segmenti vuoti/allucinazioni`);
    }
    console.log(`[Bardo] ✅ Pulizia completata: ${cleanedSegments.length} segmenti validi`);

    return {
        segments: cleanedSegments
    };
}

/**
 * Smart Truncate - Privilegia scene finali e rispetta confini semantici
 * Strategia: 75% dalle scene finali (climax) + 25% dalle scene iniziali (contesto)
 * @param text Testo da troncare
 * @param maxChars Limite massimo caratteri
 * @returns Testo troncato intelligentemente
 */
function smartTruncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;

    console.log(`[SmartTruncate] Input: ${text.length} chars, Target: ${maxChars} chars`);

    // 1. Cerca marker di scena (pattern usato in processChronologicalSession)
    const sceneMarkers = [...text.matchAll(/--- CAMBIO SCENA: \[(.*?)\] - \[(.*?)\] ---/g)];

    if (sceneMarkers.length > 3) {
        console.log(`[SmartTruncate] Trovati ${sceneMarkers.length} marker. Strategia: scene finali (75%) + iniziali (25%)`);

        const targetEnd = maxChars * 0.75;
        const targetStart = maxChars * 0.25;

        // Raccolta scene finali (climax, rivelazioni)
        let endContent = '';
        let endIdx = text.length;

        for (let i = sceneMarkers.length - 1; i >= 0; i--) {
            const sceneStart = sceneMarkers[i].index || 0;
            const sceneLength = endIdx - sceneStart;

            if (endContent.length + sceneLength > targetEnd) break;

            endContent = text.substring(sceneStart, endIdx) + endContent;
            endIdx = sceneStart;
        }

        // Raccolta scene iniziali (contesto narrativo)
        let startContent = '';
        let startIdx = 0;

        for (let i = 0; i < sceneMarkers.length && startIdx < endIdx; i++) {
            const sceneEnd = sceneMarkers[i + 1]?.index || (sceneMarkers[i].index || 0) + 5000;
            const sceneLength = sceneEnd - startIdx;

            if (startContent.length + sceneLength > targetStart) break;

            startContent += text.substring(startIdx, sceneEnd);
            startIdx = sceneEnd;
        }

        const result = startContent + '\n\n[...SCENE INTERMEDIE OMESSE...]\n\n' + endContent;
        console.log(`[SmartTruncate] Output: ${result.length} chars (${sceneMarkers.length} scene campionate)`);

        return result;
    }

    // 2. Fallback: nessun marker -> 20% inizio + 80% fine
    console.log(`[SmartTruncate] Fallback: 20% inizio + 80% fine`);

    const startChunk = text.substring(0, maxChars * 0.2);
    const endChunk = text.substring(text.length - (maxChars * 0.8));

    const lastPeriodStart = startChunk.lastIndexOf('.');
    const cleanStart = lastPeriodStart > 0
        ? startChunk.substring(0, lastPeriodStart + 1)
        : startChunk;

    const firstPeriodEnd = endChunk.indexOf('.');
    const cleanEnd = firstPeriodEnd > 0
        ? endChunk.substring(firstPeriodEnd + 1)
        : endChunk;

    return cleanStart + '\n\n[...SEZIONE CENTRALE OMESSA...]\n\n' + cleanEnd;
}

/**
 * ENHANCED identifyRelevantContext - Progressive Density Sampling
 * Combina MAP phase (condensazione) + Smart Truncate (selezione scene)
 *
 * Strategia:
 * - Sessioni brevi (<50k chars): Skip MAP, solo smart truncate
 * - Sessioni lunghe (>50k chars): MAP phase per condensare + smart truncate
 * - Target finale: 300k chars (~75k token per GPT-5.2)
 */
async function identifyRelevantContext(
    campaignId: number,
    rawTranscript: string,
    snapshot: any,
    narrativeText?: string
): Promise<string[]> {

    const TARGET_CHARS = 300000; // ~75k token per GPT-5.2

    // 🆕 Prioritizza NARRATIVE se disponibile, fallback su RAW
    const sourceText = narrativeText || rawTranscript;

    // 🆕 Log per debug e monitoring
    if (narrativeText) {
        console.log(`[Context] ✅ Usando testo NARRATIVO filtrato (${sourceText.length} caratteri)`);
    } else {
        console.log(`[Context] ⚠️ NARRATIVE non disponibile, fallback su RAW (${sourceText.length} caratteri)`);
    }

    // Calcolo approssimativo token (italiano: ~2.5 char/token)
    const estimatedTokens = Math.ceil(sourceText.length / 2.5);
    // GPT-5 mini: 400k context - margine sicurezza 50k per prompt + metadata
    const MAX_CONTEXT_TOKENS = 350000;
    const USE_MAP_PHASE = estimatedTokens > MAX_CONTEXT_TOKENS;

    if (USE_MAP_PHASE) {
        console.log(`[MAP] ⚠️ Testo troppo lungo (${estimatedTokens.toLocaleString()} token stimati > ${MAX_CONTEXT_TOKENS.toLocaleString()}), attivo MAP Phase`);
    } else {
        console.log(`[Context] ✅ Testo gestibile direttamente (${estimatedTokens.toLocaleString()} token << ${MAX_CONTEXT_TOKENS.toLocaleString()}), skip MAP`);
    }

    let processedText = sourceText;

    // FASE 1: Condensazione con MAP (solo se necessario)
    if (USE_MAP_PHASE) {
        console.log(`[identifyRelevantContext] 📊 MAP phase attiva per condensazione...`);

        const chunks = splitTextInChunks(sourceText, MAX_CHUNK_SIZE, CHUNK_OVERLAP);

        const characters = getCampaignCharacters(campaignId);
        const castContext = characters.length > 0
            ? `CAST: ${characters.map(c => c.character_name).join(', ')}`
            : '';

        const condensedChunks = await processInBatches(
            chunks,
            MAP_CONCURRENCY,
            async (chunk, idx) => {
                try {
                    return await extractFactsFromChunk(chunk, idx, chunks.length, castContext);
                } catch (e) {
                    console.warn(`[MAP] Errore chunk ${idx}, uso fallback`);
                    return { text: chunk.substring(0, 5000), title: '', tokens: 0 };
                }
            },
            'MAP Phase (Condensazione per identifyRelevantContext)'
        );

        processedText = condensedChunks.map(c => c.text).join('\n\n');

        const ratio = (sourceText.length / processedText.length).toFixed(2);
        console.log(`[identifyRelevantContext] ✅ MAP completato: ${processedText.length} chars (${ratio}x compressione)`);
    }
    // (Log skip MAP già emesso sopra)

    // FASE 2: Smart Truncate (sempre, anche dopo MAP)
    const analysisText = smartTruncate(processedText, TARGET_CHARS);

    console.log(`[identifyRelevantContext] 📝 Testo finale per analisi: ${analysisText.length} chars (~${Math.round(analysisText.length / 4)} token)`);

    // FASE 3: Generazione query RAG
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

**PRIORITÀ QUERY (in ordine):**
1. **Eventi Critici Finali**: Combattimenti, morti, tradimenti, rivelazioni nelle ultime scene
2. **Relazioni NPC**: Dialoghi importanti, alleanze/conflitti menzionati
3. **Oggetti/Luoghi Chiave**: Artefatti magici, location citate ripetutamente
4. **Background Mancante**: Riferimenti a eventi passati non chiari nella trascrizione

**REGOLE:**
- Query specifiche con nomi propri (es. "Dialoghi Leosin e Erantar", "Storia della Torre Nera")
- Evita query generiche (❌ "cosa è successo", ✅ "morte del Fabbro Torun")
- Massimo 8 parole per query
- Se la sessione è solo esplorazione/travel, genera 2-3 query invece di 5

**OUTPUT:**
Restituisci un JSON con array "queries": ["query1", "query2", "query3"]`;

    const startAI = Date.now();
    try {
        const response = await summaryClient.chat.completions.create({
            model: SUMMARY_MODEL,
            messages: [
                { role: "system", content: "Sei un esperto di ricerca semantica per database D&D. Rispondi SOLO con JSON valido." },
                { role: "user", content: prompt }
            ],
            response_format: { type: "json_object" }
        });

        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;

        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, inputTokens, outputTokens, cachedTokens, latency, false);

        const parsed = JSON.parse(response.choices[0].message.content || '{"queries":[]}');
        const queries = Array.isArray(parsed) ? parsed : (parsed.queries || parsed.list || parsed.items || []);

        console.log(`[identifyRelevantContext] ✅ Generate ${queries.length} query RAG in ${latency}ms`);
        console.log(`[identifyRelevantContext] Query: ${queries.join(' | ')}`);

        return queries.slice(0, 5); // Max 5 ricerche

    } catch (e) {
        console.error('[identifyRelevantContext] ❌ Errore generazione query:', e);
        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, 0, 0, 0, Date.now() - startAI, true);

        // Fallback: query generica basata su snapshot
        return [
            `Eventi recenti ${snapshot.location?.macro || 'campagna'}`,
            `Dialoghi NPC ${snapshot.presentNpcs?.slice(0, 2).join(' ') || ''}`
        ].filter(q => q.trim().length > 10);
    }
}

// ============================================
// STEP 1: ANALISTA - Estrazione Dati Strutturati
// ============================================

interface AnalystOutput {
    loot: string[];
    loot_removed: string[];
    quests: string[];
    monsters: Array<{
        name: string;
        status: string;
        count?: string;
        description?: string;      // Descrizione fisica/comportamento
        abilities?: string[];      // Abilità speciali osservate
        weaknesses?: string[];     // Debolezze scoperte
        resistances?: string[];    // Resistenze osservate
    }>;
    npc_dossier_updates: Array<{ name: string; description: string; role?: string; status?: 'ALIVE' | 'DEAD' | 'MISSING' }>;
    location_updates: Array<{ macro: string; micro: string; description: string }>;
    travel_sequence: Array<{ macro: string; micro: string; reason?: string }>; // 🆕 Sequenza spostamenti cronologica
    present_npcs: string[];
}

/**
 * STEP 1: Analista - Estrae dati strutturati dal testo narrativo.
 * Usa un modello economico (gpt-4o-mini) per precisione sui dati.
 */
async function extractStructuredData(
    narrativeText: string,
    castContext: string,
    memoryContext: string
): Promise<AnalystOutput> {
    console.log(`[Analista] 📊 Estrazione dati strutturati (${narrativeText.length} chars)...`);

    const prompt = `Sei un ANALISTA DATI esperto di D&D. Il tuo UNICO compito è ESTRARRE DATI STRUTTURATI.
NON scrivere narrativa. NON riassumere. SOLO estrai e cataloga.

${castContext}
${memoryContext}

**ISTRUZIONI RIGOROSE**:
1. Leggi ATTENTAMENTE il testo
2. Estrai SOLO ciò che è ESPLICITAMENTE menzionato
3. NON inventare, NON inferire, NON aggiungere
4. Se non trovi qualcosa, lascia array vuoto []
5. **GLOSSARIO CANONICO**: Se trovi nomi simili a quelli nel contesto (NPC, Luoghi), USA IL NOME ESATTO DEL CONTESTO. Non creare duplicati (es. "Filmen" -> "Firnen").

**OUTPUT JSON RICHIESTO**:
{
    "loot": ["Lista oggetti TROVATI/OTTENUTI nella sessione - SOLO se esplicitamente menzionato il ritrovamento"],
    "loot_removed": ["Lista oggetti PERSI/USATI/CONSUMATI - SOLO se esplicitamente menzionato"],
    "quests": ["Lista missioni ACCETTATE/COMPLETATE/AGGIORNATE in questa sessione"],
    "monsters": [
        {
            "name": "Nome creatura",
            "status": "DEFEATED|ALIVE|FLED",
            "count": "numero o 'molti'",
            "description": "Descrizione fisica/aspetto (se menzionato)",
            "abilities": ["Abilità speciali osservate (es. 'soffio di fuoco', 'attacco multiplo')"],
            "weaknesses": ["Debolezze scoperte (es. 'vulnerabile al fuoco')"],
            "resistances": ["Resistenze osservate (es. 'immune al veleno')"]
        }
    ],
    "npc_dossier_updates": [
        {
            "name": "Nome PROPRIO dell'NPC (es. 'Elminster', non 'il mago')",
            "description": "Descrizione fisica/personalità basata su ciò che emerge dal testo",
            "role": "Ruolo (es. 'Mercante', 'Guardia')",
            "status": "ALIVE|DEAD|MISSING"
        }
    ],
    "location_updates": [
        {
            "macro": "Città/Regione (es. 'Waterdeep')",
            "micro": "Luogo specifico SENZA il macro (es. 'Taverna del Drago' NON 'Waterdeep - Taverna del Drago')",
            "description": "Descrizione atmosferica del luogo (per Atlante)"
        }
    ],
    "travel_sequence": [
        {
            "macro": "Città/Regione",
            "micro": "Luogo specifico SENZA ripetere il macro",
            "reason": "Motivo spostamento (opzionale)"
        }
    ],
    "present_npcs": ["Lista TUTTI i nomi NPC menzionati nel testo"]
}

**REGOLE CRITICHE**:
- I PG (Personaggi Giocanti nel CONTESTO sopra) NON vanno in npc_dossier_updates
- Per il loot: "parlano di una spada" ≠ "trovano una spada". Estrai SOLO acquisizioni certe.
- Per le quest: Solo se c'è una chiara accettazione/completamento/aggiornamento
- Per i mostri: Solo creature ostili combattute, non NPC civili. **ESTRAI DETTAGLI**: se i PG scoprono abilità, debolezze o resistenze durante il combattimento, REGISTRALE (es. "il drago sputa fuoco" → abilities: ["soffio di fuoco"])
- **TRAVEL vs LOCATION**: travel_sequence = SEQUENZA CRONOLOGICA dei luoghi FISICAMENTE visitati (dall'inizio alla fine, l'ultimo è la posizione finale). location_updates = descrizioni per l'Atlante (solo luoghi con descrizione significativa)

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

        if (ANALYST_PROVIDER === 'openai') {
            options.response_format = { type: "json_object" };
        } else if (ANALYST_PROVIDER === 'ollama') {
            options.format = 'json';
        }

        const response = await analystClient.chat.completions.create(options);
        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;

        monitor.logAIRequestWithCost('analyst', ANALYST_PROVIDER, ANALYST_MODEL, inputTokens, outputTokens, cachedTokens, latency, false);

        const parsed = safeJsonParse(response.choices[0].message.content || "{}");
        console.log(`[Analista] ✅ Dati estratti in ${latency}ms`);

        // Normalizza status NPC al tipo corretto
        const validStatuses = ['ALIVE', 'DEAD', 'MISSING'] as const;
        const normalizedNpcUpdates = Array.isArray(parsed?.npc_dossier_updates)
            ? parsed.npc_dossier_updates.map((npc: any) => ({
                name: npc.name,
                description: npc.description,
                role: npc.role,
                status: validStatuses.includes(npc.status) ? npc.status as 'ALIVE' | 'DEAD' | 'MISSING' : undefined
            }))
            : [];

        // Normalizza location_updates (rimuove prefissi duplicati)
        const rawLocationUpdates = Array.isArray(parsed?.location_updates) ? parsed.location_updates : [];
        const normalizedLocationUpdates = rawLocationUpdates.map((loc: any) => {
            if (loc.macro && loc.micro) {
                const normalized = normalizeLocationNames(loc.macro, loc.micro);
                return { ...loc, macro: normalized.macro, micro: normalized.micro };
            }
            return loc;
        });

        // Normalizza travel_sequence (rimuove prefissi duplicati)
        const rawTravelSequence = Array.isArray(parsed?.travel_sequence) ? parsed.travel_sequence : [];
        const normalizedTravelSequence = rawTravelSequence.map((step: any) => {
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
        return {
            loot: [],
            loot_removed: [],
            quests: [],
            monsters: [],
            npc_dossier_updates: [],
            location_updates: [],
            travel_sequence: [],
            present_npcs: []
        };
    }
}

// ============================================
// STEP 2: SCRITTORE - Narrazione (generateSummary)
// ============================================

export async function generateSummary(sessionId: string, tone: ToneKey = 'DM', narrativeText?: string): Promise<SummaryResponse> {
    console.log(`[Bardo] 📚 Generazione Riassunto per sessione ${sessionId} (Model: ${SUMMARY_MODEL})...`);
    if (narrativeText) {
        console.log(`[Bardo] 📝 Usando testo narrativo pre-elaborato (${narrativeText.length} chars)`);
    }

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

    // --- TOTAL RECALL (CONTEXT INJECTION HYBRID) ---
    let memoryContext = "";
    if (campaignId) {
        console.log(`[Bardo] 🧠 Avvio Total Recall Ibrido (Statico + Agentico)...`);
        const snapshot = getCampaignSnapshot(campaignId);

        // 1. Contesto Statico (Base sicura)
        const staticQueries = [];
        // Se c'è un luogo, cerchiamo info su di esso
        const locationQuery = snapshot.location ? `${snapshot.location.macro || ''} ${snapshot.location.micro || ''}`.trim() : "";
        if (locationQuery) staticQueries.push(searchKnowledge(campaignId, `Info su luogo: ${locationQuery}`, 2)); // Limitiamo a 2

        // 2. Contesto Dinamico (Agentic RAG)
        // Ricostruiamo il testo grezzo per l'analisi (senza note, solo parlato)
        const rawTranscript = transcriptions.map(t => t.transcription_text).join('\n');

        // L'agente decide cosa cercare
        const textForAnalysis = (narrativeText && narrativeText.length > 100) ? narrativeText : rawTranscript;
        const dynamicQueries = await identifyRelevantContext(campaignId, textForAnalysis, snapshot, narrativeText);

        // Eseguiamo le ricerche dinamiche
        const dynamicPromises = dynamicQueries.map(q => searchKnowledge(campaignId, q, 3));

        // Eseguiamo tutto in parallelo
        const [staticResults, ...dynamicResults] = await Promise.all([
            Promise.all(staticQueries),
            ...dynamicPromises
        ]);

        // Costruzione Stringa Contesto
        memoryContext = `\n[[MEMORIA DEL MONDO E CONTESTO]]\n`;
        memoryContext += `📍 LUOGO: ${snapshot.location_context}\n`;
        memoryContext += `⚔️ QUEST ATTIVE: ${snapshot.quest_context}\n`;
        if (snapshot.atlasDesc) memoryContext += `📖 GUIDA ATLANTE: ${snapshot.atlasDesc}\n`;

        // 🆕 LISTA NPC ESISTENTI (per riconciliazione nomi)
        const existingNpcs = listNpcs(campaignId);
        if (existingNpcs.length > 0) {
            memoryContext += `\n👥 NPC GIÀ NOTI (DOSSIER ESISTENTE - USA QUESTI NOMI!):\n`;
            existingNpcs.forEach((npc: any) => {
                let npcLine = `- "${npc.name}" (${npc.role || '?'})`;
                if (npc.aliases) {
                    npcLine += ` [Alias: ${npc.aliases}]`;
                }
                memoryContext += npcLine + '\n';
            });
            memoryContext += `⚠️ Se senti nomi simili a quelli sopra (es. "Leo Sin" per "Leosin"), USA IL NOME COMPLETO DAL DOSSIER!\n`;
        }

        // 🆕 LISTA LUOGHI ESISTENTI (per riconciliazione luoghi)
        const existingLocations = listAtlasEntries(campaignId, 50); // Limitiamo a 50 per non esplodere il contesto
        if (existingLocations.length > 0) {
            memoryContext += `\n🗺️ LUOGHI GIÀ NOTI (ATLANTE - USA QUESTI NOMI!):\n`;
            existingLocations.forEach((loc: any) => {
                memoryContext += `- "${loc.macro_location} - ${loc.micro_location}"\n`;
            });
        }

        // Aggiungiamo i risultati RAG
        const allMemories = [...staticResults.flat(), ...dynamicResults.flat()];
        // Deduplica stringhe identiche
        const uniqueMemories = Array.from(new Set(allMemories));

        if (uniqueMemories.length > 0) {
            memoryContext += `\n🔍 RICORDI RILEVANTI (Dall'Archivio):\n${uniqueMemories.map(m => `- ${m}`).join('\n')}\n`;
        }
        memoryContext += `\n--------------------------------------------------\n`;
    }

    // Ricostruzione dialogo lineare usando la nuova utility
    // Se abbiamo il testo narrativo pre-elaborato, usiamo quello (più pulito)
    let fullDialogue: string;
    if (narrativeText && narrativeText.length > 100) {
        fullDialogue = narrativeText;
        console.log(`[Bardo] ✅ Usando testo narrativo pulito (${fullDialogue.length} chars) invece delle trascrizioni raw`);
    } else {
        const processed = processChronologicalSession(transcriptions, notes, startTime, campaignId);
        fullDialogue = processed.linearText;
        console.log(`[Bardo] ⚠️ Fallback a trascrizioni standard (${fullDialogue.length} chars)`);
    }

    let contextForFinalStep = "";
    let accumulatedTokens = 0;

    // ============================================
    // STEP 1: ANALISTA - Estrazione Dati Strutturati
    // ============================================
    console.log(`[Bardo] 📊 STEP 1: Analista - Estrazione dati strutturati...`);
    const analystData = await extractStructuredData(fullDialogue, castContext, memoryContext);
    console.log(`[Bardo] ✅ Analista completato: ${analystData.loot.length} loot, ${analystData.monsters.length} mostri, ${analystData.npc_dossier_updates.length} NPC`);

    // FASE MAP: Analisi frammenti (solo per testi molto lunghi)
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

    // ============================================
    // STEP 2: SCRITTORE - Narrazione Epica
    // ============================================
    console.log(`[Bardo] ✍️ STEP 2: Scrittore - Narrazione epica (${tone})...`);

    // INIEZIONE DATI ANALISTA
    const analystJson = JSON.stringify(analystData, null, 2);

    let reducePrompt = "";
    if (tone === 'DM') {
        // PROMPT SCRITTORE: Solo narrazione, i dati strutturati vengono dall'Analista
        reducePrompt = `Sei uno SCRITTORE FANTASY esperto di D&D. Il tuo UNICO compito è SCRIVERE.
I dati strutturati (loot, quest, mostri, NPC) sono già stati estratti da un analista.
Tu devi concentrarti SOLO sulla NARRAZIONE EPICA.

CONTESTO PERSONAGGI:
${castContext}

MEMORIA DEL MONDO (per riferimento, NON inventare eventi):
${memoryContext}

DATI ESTRATTI DALL'ANALISTA (Usa questi fatti come ossatura della narrazione):
${analystJson}

**IL TUO COMPITO**: Scrivi un racconto epico e coinvolgente della sessione.
Concentrati su: atmosfera, emozioni, dialoghi, colpi di scena, introspezione dei personaggi.

**OUTPUT JSON** (SOLO questi campi):
{
  "title": "Titolo evocativo e memorabile per la sessione",
  "narrative": "Il racconto COMPLETO della sessione. Scrivi in prosa romanzesca, terza persona, passato. Includi dialoghi (con «»), descrizioni atmosferiche, emozioni dei personaggi. DEVE essere LUNGO e DETTAGLIATO - almeno 3000-5000 caratteri.",
  "narrativeBrief": "MASSIMO 1800 caratteri. Mini-racconto autonomo che cattura l'essenza della sessione. Per Discord/email.",
  "log": ["[Luogo] Chi -> Azione -> Risultato (formato tecnico per il DM)"],
  "character_growth": [
    {"name": "Nome PG", "event": "Evento significativo per il personaggio", "type": "TRAUMA|ACHIEVEMENT|RELATIONSHIP|GOAL_CHANGE"}
  ],
  "npc_events": [
    {"name": "Nome NPC", "event": "Evento chiave che coinvolge questo NPC", "type": "REVELATION|BETRAYAL|DEATH|ALLIANCE|STATUS_CHANGE"}
  ],
  "world_events": [
    {"event": "Evento che cambia il mondo di gioco", "type": "POLITICS|WAR|DISASTER|DISCOVERY"}
  ]
}

**STILE NARRATIVO**:
- "Show, don't tell": Non dire "era coraggioso", mostra le sue azioni
- I dialoghi devono essere vivi e caratterizzanti
- Descrivi le emozioni e i pensieri dei personaggi
- Usa i cambi di scena per strutturare il racconto
- Il "narrative" deve essere un RACCONTO COMPLETO, non un riassunto
- **GLOSSARIO**: Se devi citare NPC o Luoghi, usa i nomi esatti presenti nella MEMORIA DEL MONDO.

**REGOLE**:
- NON estrarre loot/quest/mostri (fatto dall'Analista)
- NON inventare eventi non presenti nel testo
- Rispondi SOLO in ITALIANO
- Il "log" è tecnico e conciso, il "narrative" è epico e dettagliato
`;
    } else {
        // PROMPT SCRITTORE (non-DM): Solo narrazione, i dati strutturati vengono dall'Analista
        reducePrompt = `Sei un Bardo. ${TONES[tone] || TONES.EPICO}
${castContext}
${memoryContext}

DATI ESTRATTI DALL'ANALISTA (Usa questi fatti come ossatura della narrazione):
${analystJson}

**IL TUO COMPITO**: Scrivi un racconto della sessione nel tono richiesto.
I dati strutturati (loot, quest, mostri, NPC, luoghi) sono già stati estratti da un analista separato.
Tu devi concentrarti SOLO sulla NARRAZIONE.

ISTRUZIONI DI STILE:
- "Show, don't tell": Non dire che un personaggio è coraggioso, descrivi le sue azioni intrepide.
- Attribuisci correttamente i dialoghi agli NPC specifici anche se provengono dalla trascrizione del DM.
- Le righe marcate con 📝 [NOTA UTENTE] sono fatti certi inseriti manualmente dai giocatori.
- Usa i marker "--- CAMBIO SCENA ---" nel testo per strutturare il racconto in capitoli.
- **GLOSSARIO**: Se devi citare NPC o Luoghi, usa i nomi esatti presenti nella MEMORIA DEL MONDO.

**OUTPUT JSON** (SOLO questi campi narrativi):
{
  "title": "Titolo evocativo per la sessione",
  "narrative": "Il testo narrativo COMPLETO della sessione. Scrivi in prosa avvincente, terza persona, tempo passato. Includi dialoghi (con «»), atmosfera, emozioni. NESSUN LIMITE di lunghezza - sii dettagliato!",
  "narrativeBrief": "Mini-racconto autonomo per Discord/email. MASSIMO 1800 caratteri.",
  "log": ["[Luogo] Chi -> Azione -> Risultato (formato tecnico per il DM)"],
  "character_growth": [
    {"name": "Nome PG", "event": "Evento significativo", "type": "TRAUMA|ACHIEVEMENT|RELATIONSHIP|GOAL_CHANGE"}
  ],
  "npc_events": [
    {"name": "Nome NPC", "event": "Evento chiave", "type": "REVELATION|BETRAYAL|DEATH|ALLIANCE|STATUS_CHANGE"}
  ],
  "world_events": [
    {"event": "Evento che cambia il mondo", "type": "POLITICS|WAR|DISASTER|DISCOVERY"}
  ]
}

**REGOLE**:
- NON estrarre loot/quest/mostri/NPC/luoghi (fatto dall'Analista)
- NON inventare eventi non presenti nel testo
- Rispondi SOLO con JSON valido in ITALIANO`;
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

        // finalSummary: campo legacy, usa narrative se disponibile
        let finalSummary = parsed.narrative || parsed.summary || "";

        // Fallback estremo: se non c'è narrativa, usa i log
        if (!finalSummary && Array.isArray(parsed.log) && parsed.log.length > 0) {
            finalSummary = parsed.log.join('\n');
        }

        // ESTRAZIONE DATI STRUTTURATI DAL DB (identici alla mail)
        let sessionData: SummaryResponse['session_data'] = undefined;

        if (campaignId) {
            const campaign = getCampaignById(campaignId);
            const sessionNum = getExplicitSessionNumber(sessionId) || "?";
            const travels = getSessionTravelLog(sessionId);
            const npcs = getSessionEncounteredNPCs(sessionId);

            // Formatta la data come nella mail
            const sessionDate = startTime
                ? new Date(startTime).toLocaleDateString('it-IT', {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                })
                : new Date().toLocaleDateString('it-IT', {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                });

            sessionData = {
                travels: travels.map(t => ({
                    timestamp: t.timestamp,
                    macro_location: t.macro_location,
                    micro_location: t.micro_location
                })),
                encountered_npcs: npcs.map(n => ({
                    name: n.name,
                    role: n.role,
                    status: n.status,
                    description: n.description
                })),
                campaign_info: {
                    name: campaign?.name || 'Campagna',
                    session_number: sessionNum,
                    session_date: sessionDate
                }
            };
        }

        // ============================================
        // MERGE: Dati Analista + Narrazione Scrittore
        // ============================================
        return {
            // DALLO SCRITTORE (narrazione)
            summary: finalSummary || "Errore generazione.", // Legacy field (stesso contenuto di narrative)
            title: parsed.title || "Sessione Senza Titolo",
            tokens: accumulatedTokens,
            narrative: finalSummary || "Errore generazione.", // Per RAG (senza limiti)
            narrativeBrief: parsed.narrativeBrief || (finalSummary.substring(0, 1800) + (finalSummary.length > 1800 ? "..." : "")), // Per Discord/Email (~1800 chars)
            log: Array.isArray(parsed.log) ? parsed.log : [],
            character_growth: Array.isArray(parsed.character_growth) ? parsed.character_growth : [],
            npc_events: Array.isArray(parsed.npc_events) ? parsed.npc_events : [],
            world_events: Array.isArray(parsed.world_events) ? parsed.world_events : [],
            // DALL'ANALISTA (dati strutturati)
            loot: analystData.loot,
            loot_removed: analystData.loot_removed,
            quests: analystData.quests,
            monsters: analystData.monsters,
            npc_dossier_updates: analystData.npc_dossier_updates,
            location_updates: analystData.location_updates,
            travel_sequence: analystData.travel_sequence, // 🆕 Sequenza spostamenti cronologica
            present_npcs: analystData.present_npcs,
            // METADATI SESSIONE
            session_data: sessionData
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

// --- GENERATORE NOTE NPC (Adattivo & Lossless) ---
export async function regenerateNpcNotes(campaignId: number, npcName: string, role: string, staticDesc: string): Promise<string> {
    const history = getNpcHistory(campaignId, npcName);

    const historyText = history.length > 0
        ? history.map((h: any) => `[${h.event_type}] ${h.description}`).join('\n')
        : "Nessun evento storico specifico registrato.";

    // Calcoliamo la "densità" della storia per guidare l'AI
    const complexityLevel = history.length > 5 ? "DETTAGLIATO" : "CONCISO";

    const prompt = `Sei il Biografo Ufficiale di una campagna D&D.
    Devi aggiornare il Dossier per l'NPC: **${npcName}**.
    
    RUOLO: ${role}
    DESCRIZIONE PRECEDENTE (Usa questa SOLO per aspetto fisico e personalità): 
    "${staticDesc}"
    
    CRONOLOGIA COMPLETA DEGLI EVENTI (Usa questa come fonte di verità per la storia):
    ${historyText}
    
    OBIETTIVO:
    Scrivi una biografia aggiornata che integri coerentemente i nuovi eventi.
    
    ISTRUZIONI DI SCRITTURA:
    1. **Lunghezza Adattiva:** La lunghezza del testo DEVE essere proporzionale alla quantità di eventi nella cronologia. 
       - Se ci sono pochi eventi, sii breve.
       - Se ci sono molti eventi, scrivi una storia ricca e dettagliata. NON RIASSUMERE ECCESSIVAMENTE.
    2. **Struttura:**
       - Inizia con l'aspetto fisico e la personalità (presi dalla Descrizione Precedente).
       - Prosegui con la narrazione delle sue gesta in ordine cronologico (prese dalla Cronologia).
       - Concludi con la sua situazione attuale.
    3. **Preservazione:** Non inventare fatti non presenti, ma collegali in modo logico.
    4. **Stile:** ${complexityLevel === "DETTAGLIATO" ? "Epico, narrativo e approfondito." : "Diretto e informativo."}
    
    Restituisci SOLO il testo della nuova biografia.`;

    const startAI = Date.now();
    try {
        const response = await summaryClient.chat.completions.create({
            model: SUMMARY_MODEL, // Assicurati che questo modello supporti un buon output window (es. gpt-4o o simile)
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

        return response.choices[0].message.content || staticDesc;
    } catch (e) {
        console.error("Errore rigenerazione note NPC:", e);
        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, 0, 0, 0, Date.now() - startAI, true);
        return staticDesc;
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

// Add this helper function
export async function resolveIdentityCandidate(campaignId: number, newName: string, newDesc: string): Promise<{ match: string | null, confidence: number }> {
    const existingNpcs = listNpcs(campaignId);
    if (existingNpcs.length === 0) return { match: null, confidence: 0 };

    // Pass only minimal context to save tokens
    const candidates = existingNpcs.map((n: any) => `- ${n.name} (${n.role})`).join('\n');

    const prompt = `Analizza se il NUOVO NPC è un duplicato di uno ESISTENTE.
    NUOVO: "${newName}" - ${newDesc}
    ESISTENTI:
    ${candidates}
    
    Rispondi JSON: { "match": "NomeEsattoEsistente" | null, "confidence": 0.0-1.0 }`;

    const startAI = Date.now();
    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" }
        });
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;
        monitor.logAIRequestWithCost('metadata', METADATA_PROVIDER, METADATA_MODEL, inputTokens, outputTokens, cachedTokens, Date.now() - startAI, false);
        return JSON.parse(response.choices[0].message.content || "{}");
    } catch (e) {
        monitor.logAIRequestWithCost('metadata', METADATA_PROVIDER, METADATA_MODEL, 0, 0, 0, Date.now() - startAI, true);
        return { match: null, confidence: 0 };
    }
}

// --- HELPER: SMART MERGE ---
export async function smartMergeBios(existingBio: string, newInfo: string): Promise<string> {
    const prompt = `Sei un archivista di D&D.
    Devi aggiornare la scheda biografica di un NPC unendo le informazioni vecchie con quelle nuove appena scoperte.
    
    DESCRIZIONE ESISTENTE:
    "${existingBio}"
    
    NUOVE INFORMAZIONI (da integrare):
    "${newInfo}"
    
    COMPITO:
    Riscrivi una SINGOLA descrizione coerente in italiano che:
    1. Integri i fatti nuovi nel testo esistente.
    2. Elimini le ripetizioni (es. se entrambi dicono "è ferito", dillo una volta sola).
    3. Mantenga lo stile conciso da dossier.
    4. Aggiorni lo stato fisico se le nuove info sono più recenti.
    
    Restituisci SOLO il testo della nuova descrizione, niente altro.`;

    const startAI = Date.now();
    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL, // Use a fast/smart model
            messages: [{ role: "user", content: prompt }]
        });
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;
        monitor.logAIRequestWithCost('metadata', METADATA_PROVIDER, METADATA_MODEL, inputTokens, outputTokens, cachedTokens, Date.now() - startAI, false);
        return response.choices[0].message.content || existingBio + " | " + newInfo;
    } catch (e) {
        console.error("Smart Merge failed, falling back to concat:", e);
        monitor.logAIRequestWithCost('metadata', METADATA_PROVIDER, METADATA_MODEL, 0, 0, 0, Date.now() - startAI, true);
        return `${existingBio} | ${newInfo}`; // Fallback sicuro
    }
}

// --- NPC NAME RECONCILIATION (Fuzzy + AI) ---

/**
 * Calcola la distanza di Levenshtein normalizzata (0-1, dove 1 = identico)
 */
function levenshteinSimilarity(a: string, b: string): number {
    const al = a.toLowerCase().trim();
    const bl = b.toLowerCase().trim();

    if (al === bl) return 1;
    if (al.length === 0 || bl.length === 0) return 0;

    const matrix: number[][] = [];

    for (let i = 0; i <= bl.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= al.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= bl.length; i++) {
        for (let j = 1; j <= al.length; j++) {
            if (bl.charAt(i - 1) === al.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }

    const distance = matrix[bl.length][al.length];
    const maxLen = Math.max(al.length, bl.length);
    return 1 - distance / maxLen;
}

/**
 * Verifica se un nome contiene l'altro come sottostringa (es. "Leo Sin" in "Leosin")
 */
function containsSubstring(name1: string, name2: string): boolean {
    const n1 = name1.toLowerCase().replace(/\s+/g, '');
    const n2 = name2.toLowerCase().replace(/\s+/g, '');
    return n1.includes(n2) || n2.includes(n1);
}

/**
 * Versione POTENZIATA: Chiede all'AI se due nomi sono la stessa persona usando RAG + Fonetica
 */
async function aiConfirmSamePersonExtended(
    campaignId: number,
    newName: string,
    newDescription: string,
    candidateName: string,
    candidateDescription: string
): Promise<boolean> {

    // 1. Cerca nel RAG usando la descrizione del NUOVO personaggio
    // Questo serve a vedere se la descrizione di "Siri" fa emergere ricordi di "Ciri"
    const ragQuery = `Chi è ${newName}? ${newDescription}`;
    const ragContext = await searchKnowledge(campaignId, ragQuery, 2); // Prendiamo solo i top 2 frammenti

    // Filtriamo i frammenti per vedere se menzionano il CANDIDATO
    const relevantFragments = ragContext.filter(f =>
        f.toLowerCase().includes(candidateName.toLowerCase())
    );

    const ragContextText = relevantFragments.length > 0
        ? `\nMEMORIA STORICA RILEVANTE:\n${relevantFragments.join('\n')}`
        : "";

    const prompt = `Sei un esperto di D&D. Rispondi SOLO con "SI" o "NO".

Domanda: Il nuovo NPC "${newName}" è in realtà l'NPC esistente "${candidateName}" (errore di trascrizione o soprannome)?

CONFRONTO DATI:
- NUOVO (${newName}): "${newDescription}"
- ESISTENTE (${candidateName}): "${candidateDescription}"
${ragContextText}

CRITERI DI GIUDIZIO:
1. **Fonetica:** Se suonano simili (Siri/Ciri), è un forte indizio.
2. **Contesto (RAG):** Se la "Memoria Storica" di ${candidateName} descrive fatti identici a quelli del nuovo NPC, SONO la stessa persona.
3. **Logica:** Se uno è "Ostaggio dei banditi" e l'altro è "Prigioniera dei briganti", SONO la stessa persona.

Rispondi SOLO: SI oppure NO`;

    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 5
        });
        const answer = response.choices[0].message.content?.toUpperCase().trim() || "";
        return answer.includes("SI") || answer.includes("SÌ") || answer === "YES";
    } catch (e) {
        console.error("[Reconcile] ❌ Errore AI confirm:", e);
        return false;
    }
}

/**
 * Chiede all'AI se due nomi si riferiscono alla stessa persona.
 */
async function aiConfirmSamePerson(name1: string, name2: string, context: string = ""): Promise<boolean> {
    const prompt = `Sei un esperto di D&D. Rispondi SOLO con "SI" o "NO".

Domanda: "${name1}" e "${name2}" sono la STESSA persona/NPC?

Considera che:
- I nomi potrebbero essere pronunce errate o parziali (es. "Leo Sin" = "Leosin")
- Potrebbero essere soprannomi (es. "Rantar" potrebbe essere il cognome di "Leosin Erantar")
- Le trascrizioni audio spesso dividono i nomi (es. "Leosin Erantar" → "Leo Sin" + "Rantar")

${context ? `Contesto aggiuntivo: ${context}` : ''}

Rispondi SOLO: SI oppure NO`;

    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 5
        });
        const answer = response.choices[0].message.content?.toUpperCase().trim() || "";
        return answer.includes("SI") || answer.includes("SÌ") || answer === "YES";
    } catch (e) {
        console.error("[Reconcile] ❌ Errore AI confirm:", e);
        return false;
    }
}

/**
 * Trova il nome canonico se esiste un NPC simile nel dossier.
 * Ritorna { canonicalName, shouldMerge } o null se non trovato.
 */
export async function reconcileNpcName(
    campaignId: number,
    newName: string,
    newDescription: string = ""
): Promise<{ canonicalName: string; existingNpc: any } | null> {
    const existingNpcs = listNpcs(campaignId);
    if (existingNpcs.length === 0) return null;

    const newNameLower = newName.toLowerCase().trim();

    // 1. Match esatto (case-insensitive) → nessuna riconciliazione necessaria
    const exactMatch = existingNpcs.find((n: any) => n.name.toLowerCase() === newNameLower);
    if (exactMatch) return null; // Già esiste con lo stesso nome

    // 2. Cerca candidati simili
    const candidates: Array<{ npc: any; similarity: number; reason: string }> = [];

    for (const npc of existingNpcs) {
        const existingName = npc.name;
        const similarity = levenshteinSimilarity(newName, existingName);

        // Threshold dinamico basato sulla lunghezza
        const minLen = Math.min(newName.length, existingName.length);
        const threshold = minLen < 6 ? 0.7 : 0.6;

        // Check 1: Alta similarità Levenshtein
        if (similarity >= threshold) {
            candidates.push({ npc, similarity, reason: `levenshtein=${similarity.toFixed(2)}` });
            continue;
        }

        // Check 2: Uno contiene l'altro (senza spazi)
        if (containsSubstring(newName, existingName)) {
            candidates.push({ npc, similarity: 0.8, reason: 'substring_match' });
            continue;
        }

        // Check 3: Parti del nome in comune (es. "Leosin" e "Leo Sin")
        const newParts = newName.toLowerCase().split(/\s+/);
        const existingParts = existingName.toLowerCase().split(/\s+/);

        for (const np of newParts) {
            for (const ep of existingParts) {
                if (np.length > 3 && ep.length > 3 && levenshteinSimilarity(np, ep) > 0.8) {
                    candidates.push({ npc, similarity: 0.75, reason: `part_match: ${np}≈${ep}` });
                }
            }
        }
    }

    if (candidates.length === 0) return null;

    // Ordina per similarità decrescente
    candidates.sort((a, b) => b.similarity - a.similarity);

    // 3. VERIFICA POTENZIATA CON RAG
    // Prendiamo solo il miglior candidato per risparmiare token/tempo
    const bestCandidate = candidates[0];

    console.log(`[Reconcile] 🔍 "${newName}" simile a "${bestCandidate.npc.name}" (${bestCandidate.reason}). Avvio Deep Check (RAG)...`);

    const isSame = await aiConfirmSamePersonExtended(
        campaignId,
        newName,
        newDescription, // Passiamo la descrizione estratta dal summary corrente
        bestCandidate.npc.name,
        bestCandidate.npc.description || ""
    );

    if (isSame) {
        console.log(`[Reconcile] ✅ CONFERMATO: "${newName}" = "${bestCandidate.npc.name}"`);
        return { canonicalName: bestCandidate.npc.name, existingNpc: bestCandidate.npc };
    } else {
        console.log(`[Reconcile] ❌ "${newName}" ≠ "${bestCandidate.npc.name}"`);
    }

    return null;
}

/**
 * Pre-deduplica un batch di NPC updates PRIMA di salvarli.
 * Unisce nomi simili nello stesso batch (es. "Leosin Erantar" e "Leosin Erentar").
 */
export async function deduplicateNpcBatch(
    npcs: Array<{ name: string; description: string; role?: string; status?: string }>
): Promise<Array<{ name: string; description: string; role?: string; status?: string }>> {
    if (npcs.length <= 1) return npcs;

    const result: Array<{ name: string; description: string; role?: string; status?: string }> = [];
    const processed = new Set<number>();

    for (let i = 0; i < npcs.length; i++) {
        if (processed.has(i)) continue;

        let merged = { ...npcs[i] };
        processed.add(i);

        // Cerca duplicati nel resto del batch
        for (let j = i + 1; j < npcs.length; j++) {
            if (processed.has(j)) continue;

            const similarity = levenshteinSimilarity(merged.name, npcs[j].name);
            const hasSubstring = containsSubstring(merged.name, npcs[j].name);

            if (similarity > 0.7 || hasSubstring) {
                // Chiedi all'AI se sono la stessa persona
                const isSame = await aiConfirmSamePerson(merged.name, npcs[j].name);

                if (isSame) {
                    console.log(`[Batch Dedup] 🔄 "${npcs[j].name}" → "${merged.name}"`);
                    // Usa il nome più lungo come canonico
                    if (npcs[j].name.length > merged.name.length) {
                        merged.name = npcs[j].name;
                    }
                    // Unisci descrizioni
                    if (npcs[j].description && npcs[j].description !== merged.description) {
                        merged.description = `${merged.description} ${npcs[j].description}`;
                    }
                    // Prendi il ruolo/status se mancante
                    merged.role = merged.role || npcs[j].role;
                    merged.status = merged.status || npcs[j].status;

                    processed.add(j);
                }
            }
        }

        result.push(merged);
    }

    if (result.length < npcs.length) {
        console.log(`[Batch Dedup] ✅ Ridotti ${npcs.length} NPC a ${result.length}`);
    }

    return result;
}

// =============================================
// === LOCATION RECONCILIATION (Atlas) ===
// =============================================

/**
 * Versione POTENZIATA: Chiede all'AI se due luoghi sono lo stesso posto usando RAG + Fonetica
 */
async function aiConfirmSameLocationExtended(
    campaignId: number,
    newMacro: string,
    newMicro: string,
    newDescription: string,
    candidateMacro: string,
    candidateMicro: string,
    candidateDescription: string
): Promise<boolean> {

    // 1. Cerca nel RAG usando la descrizione del NUOVO luogo
    // Es: "Com'è la 'Grotta Buia'? C'è un altare di ossa."
    const ragQuery = `Descrivi il luogo ${newMacro} - ${newMicro}. ${newDescription}`;
    const ragContext = await searchKnowledge(campaignId, ragQuery, 2);

    // Filtriamo i frammenti per vedere se menzionano il CANDIDATO (Macro o Micro)
    const relevantFragments = ragContext.filter(f =>
        f.toLowerCase().includes(candidateMacro.toLowerCase()) ||
        f.toLowerCase().includes(candidateMicro.toLowerCase())
    );

    const ragContextText = relevantFragments.length > 0
        ? `\nMEMORIA STORICA RILEVANTE:\n${relevantFragments.join('\n')}`
        : "";

    const prompt = `Sei un esperto di D&D e ambientazioni fantasy. Rispondi SOLO con "SI" o "NO".

Domanda: Il nuovo luogo "${newMacro} - ${newMicro}" è in realtà il luogo esistente "${candidateMacro} - ${candidateMicro}"?

CONFRONTO DATI:
- NUOVO: "${newDescription}"
- ESISTENTE: "${candidateDescription}"
${ragContextText}

CRITERI DI GIUDIZIO:
1. **Fonetica:** Se i nomi suonano simili o sono traduzioni/sinonimi (es. "Torre Nera" vs "Torre Oscura").
2. **Contesto (RAG):** Se la "Memoria Storica" descrive eventi accaduti nel luogo candidato che coincidono con la descrizione del nuovo luogo.
3. **Gerarchia:** Se uno è chiaramente un sotto-luogo dell'altro ma usato come nome principale.

Rispondi SOLO: SI oppure NO`;

    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 5
        });
        const answer = response.choices[0].message.content?.toUpperCase().trim() || "";
        return answer.includes("SI") || answer.includes("SÌ") || answer === "YES";
    } catch (e) {
        console.error("[Location Reconcile] ❌ Errore AI confirm:", e);
        return false;
    }
}

/**
 * Chiede all'AI se due luoghi si riferiscono allo stesso posto.
 */
async function aiConfirmSameLocation(
    loc1: { macro: string; micro: string },
    loc2: { macro: string; micro: string },
    context: string = ""
): Promise<boolean> {
    const prompt = `Sei un esperto di D&D e ambientazioni fantasy. Rispondi SOLO con "SI" o "NO".

Domanda: "${loc1.macro} - ${loc1.micro}" e "${loc2.macro} - ${loc2.micro}" sono lo STESSO luogo?

Considera che:
- I nomi potrebbero essere trascrizioni errate o parziali (es. "Palazzo centrale" = "Palazzo Centrale")
- Potrebbero essere descrizioni diverse dello stesso posto (es. "Sala del trono" = "Sala Trono")
- I luoghi macro potrebbero avere varianti (es. "Dominio di Ogma" = "Regno di Ogma")
- I micro-luoghi potrebbero essere sottoinsiemi (es. "Cancelli d'Ingresso" ≈ "Cancelli del dominio")

${context ? `Contesto aggiuntivo: ${context}` : ''}

Rispondi SOLO: SI oppure NO`;

    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 5
        });
        const answer = response.choices[0].message.content?.toUpperCase().trim() || "";
        return answer.includes("SI") || answer.includes("SÌ") || answer === "YES";
    } catch (e) {
        console.error("[Location Reconcile] ❌ Errore AI confirm:", e);
        return false;
    }
}

/**
 * Normalizza i nomi location rimuovendo prefissi duplicati.
 * Es: macro="Waterdeep", micro="Waterdeep - Mura di Waterdeep" → micro="Mura di Waterdeep"
 * Es: macro="Paludi", micro="Paludi - Paludi dei morti" → micro="Paludi dei morti"
 */
export function normalizeLocationNames(
    macro: string,
    micro: string
): { macro: string; micro: string } {
    const macroLower = macro.toLowerCase().trim();
    const microLower = micro.toLowerCase().trim();

    // Pattern 1: micro = "macro - macro - X" → micro = "X"
    // Es: "Waterdeep - Waterdeep - Mura" → "Mura"
    const doublePrefixPattern = new RegExp(`^${escapeRegex(macroLower)}\\s*-\\s*${escapeRegex(macroLower)}\\s*-\\s*`, 'i');
    if (doublePrefixPattern.test(micro)) {
        const cleaned = micro.replace(doublePrefixPattern, '').trim();
        console.log(`[Location Normalize] 🔧 "${macro} - ${micro}" → "${macro} - ${cleaned}" (doppio prefisso)`);
        return { macro: macro.trim(), micro: cleaned };
    }

    // Pattern 2: micro = "macro - X" → micro = "X"
    // Es: "Waterdeep - Mura di Waterdeep" → "Mura di Waterdeep" (quando macro è già "Waterdeep")
    const singlePrefixPattern = new RegExp(`^${escapeRegex(macroLower)}\\s*-\\s*`, 'i');
    if (singlePrefixPattern.test(micro)) {
        const cleaned = micro.replace(singlePrefixPattern, '').trim();
        // Solo se il risultato non è vuoto
        if (cleaned.length > 0) {
            console.log(`[Location Normalize] 🔧 "${macro} - ${micro}" → "${macro} - ${cleaned}" (prefisso singolo)`);
            return { macro: macro.trim(), micro: cleaned };
        }
    }

    return { macro: macro.trim(), micro: micro.trim() };
}

// Utility per escape regex special chars
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Calcola la similarità tra due luoghi (combinando macro e micro).
 */
function locationSimilarity(
    loc1: { macro: string; micro: string },
    loc2: { macro: string; micro: string }
): { score: number; reason: string } {
    const macroSim = levenshteinSimilarity(loc1.macro, loc2.macro);
    const microSim = levenshteinSimilarity(loc1.micro, loc2.micro);

    // Se i macro sono identici, confronta solo i micro
    if (macroSim > 0.95) {
        if (microSim > 0.6) {
            return { score: microSim, reason: `same_macro, micro_sim=${microSim.toFixed(2)}` };
        }
        // Check substring nei micro
        if (containsSubstring(loc1.micro, loc2.micro)) {
            return { score: 0.8, reason: 'same_macro, micro_substring' };
        }
    }

    // Se i micro sono molto simili, verifica che i macro siano almeno correlati
    if (microSim > 0.8 && macroSim > 0.5) {
        return { score: (macroSim + microSim) / 2, reason: `high_micro_sim=${microSim.toFixed(2)}` };
    }

    // Calcola similarità combinata
    const combined = (macroSim * 0.4) + (microSim * 0.6);
    if (combined > 0.6) {
        return { score: combined, reason: `combined=${combined.toFixed(2)}` };
    }

    return { score: 0, reason: 'no_match' };
}

/**
 * Trova il nome canonico se esiste un luogo simile nell'atlante.
 * Ritorna { canonicalMacro, canonicalMicro, existingEntry } o null se non trovato.
 */
export async function reconcileLocationName(
    campaignId: number,
    newMacro: string,
    newMicro: string,
    newDescription: string = ""
): Promise<{ canonicalMacro: string; canonicalMicro: string; existingEntry: any } | null> {
    const existingLocations = listAllAtlasEntries(campaignId);
    if (existingLocations.length === 0) return null;

    // Normalizza i nomi in input (rimuove prefissi duplicati)
    const normalized = normalizeLocationNames(newMacro, newMicro);
    newMacro = normalized.macro;
    newMicro = normalized.micro;

    const newMacroLower = newMacro.toLowerCase().trim();
    const newMicroLower = newMicro.toLowerCase().trim();

    // 1. Match esatto (case-insensitive) → nessuna riconciliazione necessaria
    const exactMatch = existingLocations.find((loc: any) =>
        loc.macro_location.toLowerCase() === newMacroLower &&
        loc.micro_location.toLowerCase() === newMicroLower
    );
    if (exactMatch) return null; // Già esiste con lo stesso nome

    // 2. Cerca candidati simili
    const candidates: Array<{ entry: any; similarity: number; reason: string }> = [];

    for (const entry of existingLocations) {
        const { score, reason } = locationSimilarity(
            { macro: newMacro, micro: newMicro },
            { macro: entry.macro_location, micro: entry.micro_location }
        );

        if (score > 0.55) {
            candidates.push({ entry, similarity: score, reason });
        }
    }

    if (candidates.length === 0) return null;

    // Ordina per similarità decrescente
    candidates.sort((a, b) => b.similarity - a.similarity);

    // 3. Per ogni candidato, chiedi conferma all'AI (POTENZIATA CON RAG)
    // Prendiamo solo il miglior candidato per risparmiare token/tempo
    const bestCandidate = candidates[0];

    console.log(`[Location Reconcile] 🔍 "${newMacro} - ${newMicro}" simile a "${bestCandidate.entry.macro_location} - ${bestCandidate.entry.micro_location}" (${bestCandidate.reason}). Avvio Deep Check (RAG)...`);

    const isSame = await aiConfirmSameLocationExtended(
        campaignId,
        newMacro,
        newMicro,
        newDescription,
        bestCandidate.entry.macro_location,
        bestCandidate.entry.micro_location,
        bestCandidate.entry.description || ""
    );

    if (isSame) {
        console.log(`[Location Reconcile] ✅ CONFERMATO: "${newMacro} - ${newMicro}" = "${bestCandidate.entry.macro_location} - ${bestCandidate.entry.micro_location}"`);
        return {
            canonicalMacro: bestCandidate.entry.macro_location,
            canonicalMicro: bestCandidate.entry.micro_location,
            existingEntry: bestCandidate.entry
        };
    } else {
        console.log(`[Location Reconcile] ❌ "${newMacro} - ${newMicro}" ≠ "${bestCandidate.entry.macro_location} - ${bestCandidate.entry.micro_location}"`);
    }

    return null;
}

/**
 * Pre-deduplica un batch di location updates PRIMA di salvarli.
 * Unisce luoghi simili nello stesso batch.
 */
export async function deduplicateLocationBatch(
    locations: Array<{ macro: string; micro: string; description?: string }>
): Promise<Array<{ macro: string; micro: string; description?: string }>> {
    if (locations.length <= 1) return locations;

    const result: Array<{ macro: string; micro: string; description?: string }> = [];
    const processed = new Set<number>();

    for (let i = 0; i < locations.length; i++) {
        if (processed.has(i)) continue;

        let merged = { ...locations[i] };
        processed.add(i);

        // Cerca duplicati nel resto del batch
        for (let j = i + 1; j < locations.length; j++) {
            if (processed.has(j)) continue;

            const { score } = locationSimilarity(
                { macro: merged.macro, micro: merged.micro },
                { macro: locations[j].macro, micro: locations[j].micro }
            );

            if (score > 0.6) {
                // Chiedi all'AI se sono lo stesso luogo
                const isSame = await aiConfirmSameLocation(
                    { macro: merged.macro, micro: merged.micro },
                    { macro: locations[j].macro, micro: locations[j].micro }
                );

                if (isSame) {
                    console.log(`[Location Batch Dedup] 🔄 "${locations[j].macro} - ${locations[j].micro}" → "${merged.macro} - ${merged.micro}"`);
                    // Usa il nome più lungo come canonico
                    const mergedFull = `${merged.macro} - ${merged.micro}`;
                    const jFull = `${locations[j].macro} - ${locations[j].micro}`;
                    if (jFull.length > mergedFull.length) {
                        merged.macro = locations[j].macro;
                        merged.micro = locations[j].micro;
                    }
                    // Unisci descrizioni
                    if (locations[j].description && locations[j].description !== merged.description) {
                        merged.description = `${merged.description || ''} ${locations[j].description}`.trim();
                    }
                    processed.add(j);
                }
            }
        }

        result.push(merged);
    }

    if (result.length < locations.length) {
        console.log(`[Location Batch Dedup] ✅ Ridotti ${locations.length} luoghi a ${result.length}`);
    }

    return result;
}

// =============================================
// === MONSTER RECONCILIATION (Bestiary) ===
// =============================================

/**
 * Chiede all'AI se due mostri sono lo stesso tipo.
 */
async function aiConfirmSameMonster(name1: string, name2: string, context: string = ""): Promise<boolean> {
    const prompt = `Sei un esperto di D&D e creature fantasy. Rispondi SOLO con "SI" o "NO".

Domanda: "${name1}" e "${name2}" sono lo STESSO tipo di mostro/creatura?

Considera che:
- I nomi potrebbero essere singolari/plurali (es. "Goblin" = "Goblins")
- Potrebbero essere varianti ortografiche (es. "Orco" = "Orchi")
- Potrebbero essere nomi parziali (es. "Scheletro" ≈ "Scheletro Guerriero")
- NON unire creature diverse (es. "Goblin" ≠ "Hobgoblin")

${context ? `Contesto: ${context}` : ''}

Rispondi SOLO: SI oppure NO`;

    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 5
        });
        const answer = response.choices[0].message.content?.toUpperCase().trim() || "";
        return answer.includes("SI") || answer.includes("SÌ") || answer === "YES";
    } catch (e) {
        console.error("[Monster Reconcile] ❌ Errore AI confirm:", e);
        return false;
    }
}

/**
 * Trova il nome canonico se esiste un mostro simile nel bestiario.
 */
export async function reconcileMonsterName(
    campaignId: number,
    newName: string,
    newDescription: string = ""
): Promise<{ canonicalName: string; existingMonster: any } | null> {
    const existingMonsters = listAllMonsters(campaignId);
    if (existingMonsters.length === 0) return null;

    const newNameLower = newName.toLowerCase().trim();

    // 1. Match esatto → nessuna riconciliazione
    const exactMatch = existingMonsters.find((m: any) => m.name.toLowerCase() === newNameLower);
    if (exactMatch) return null;

    // 2. Cerca candidati simili
    const candidates: Array<{ monster: any; similarity: number; reason: string }> = [];

    for (const monster of existingMonsters) {
        const existingName = monster.name;
        const similarity = levenshteinSimilarity(newName, existingName);

        // Threshold dinamico
        const minLen = Math.min(newName.length, existingName.length);
        const threshold = minLen < 6 ? 0.7 : 0.6;

        if (similarity >= threshold) {
            candidates.push({ monster, similarity, reason: `levenshtein=${similarity.toFixed(2)}` });
            continue;
        }

        // Check substring (singolare/plurale)
        if (containsSubstring(newName, existingName)) {
            candidates.push({ monster, similarity: 0.8, reason: 'substring_match' });
        }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.similarity - a.similarity);

    for (const candidate of candidates.slice(0, 3)) {
        console.log(`[Monster Reconcile] 🔍 "${newName}" simile a "${candidate.monster.name}" (${candidate.reason}). Chiedo conferma AI...`);

        const isSame = await aiConfirmSameMonster(newName, candidate.monster.name, newDescription);

        if (isSame) {
            console.log(`[Monster Reconcile] ✅ CONFERMATO: "${newName}" = "${candidate.monster.name}"`);
            return { canonicalName: candidate.monster.name, existingMonster: candidate.monster };
        } else {
            console.log(`[Monster Reconcile] ❌ "${newName}" ≠ "${candidate.monster.name}"`);
        }
    }

    return null;
}

/**
 * Pre-deduplica un batch di mostri.
 */
export async function deduplicateMonsterBatch(
    monsters: Array<{ name: string; status?: string; count?: string; description?: string; abilities?: string[]; weaknesses?: string[]; resistances?: string[] }>
): Promise<Array<{ name: string; status?: string; count?: string; description?: string; abilities?: string[]; weaknesses?: string[]; resistances?: string[] }>> {
    if (monsters.length <= 1) return monsters;

    const result: typeof monsters = [];
    const processed = new Set<number>();

    for (let i = 0; i < monsters.length; i++) {
        if (processed.has(i)) continue;

        let merged = { ...monsters[i] };
        processed.add(i);

        for (let j = i + 1; j < monsters.length; j++) {
            if (processed.has(j)) continue;

            const similarity = levenshteinSimilarity(merged.name, monsters[j].name);
            const hasSubstring = containsSubstring(merged.name, monsters[j].name);

            if (similarity > 0.7 || hasSubstring) {
                const isSame = await aiConfirmSameMonster(merged.name, monsters[j].name);

                if (isSame) {
                    console.log(`[Monster Batch Dedup] 🔄 "${monsters[j].name}" → "${merged.name}"`);
                    // Usa nome più lungo
                    if (monsters[j].name.length > merged.name.length) {
                        merged.name = monsters[j].name;
                    }
                    // Unisci dettagli
                    merged.description = merged.description || monsters[j].description;
                    merged.abilities = [...new Set([...(merged.abilities || []), ...(monsters[j].abilities || [])])];
                    merged.weaknesses = [...new Set([...(merged.weaknesses || []), ...(monsters[j].weaknesses || [])])];
                    merged.resistances = [...new Set([...(merged.resistances || []), ...(monsters[j].resistances || [])])];
                    // Status più grave
                    if (monsters[j].status === 'DEFEATED') merged.status = 'DEFEATED';
                    processed.add(j);
                }
            }
        }

        result.push(merged);
    }

    if (result.length < monsters.length) {
        console.log(`[Monster Batch Dedup] ✅ Ridotti ${monsters.length} mostri a ${result.length}`);
    }

    return result;
}

// =============================================
// === ITEM RECONCILIATION (Inventory) ===
// =============================================

/**
 * Chiede all'AI se due oggetti sono lo stesso item.
 */
async function aiConfirmSameItem(item1: string, item2: string, context: string = ""): Promise<boolean> {
    const prompt = `Sei un esperto di D&D e oggetti fantasy. Rispondi SOLO con "SI" o "NO".

Domanda: "${item1}" e "${item2}" sono lo STESSO oggetto?

Considera che:
- Potrebbero essere abbreviazioni (es. "Pozione di cura" = "Pozione Cura")
- Potrebbero essere varianti (es. "100 monete d'oro" ≈ "100 mo")
- NON unire oggetti diversi (es. "Spada +1" ≠ "Spada +2")
- NON unire categorie diverse (es. "Pozione di cura" ≠ "Pozione di forza")

${context ? `Contesto: ${context}` : ''}

Rispondi SOLO: SI oppure NO`;

    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 5
        });
        const answer = response.choices[0].message.content?.toUpperCase().trim() || "";
        return answer.includes("SI") || answer.includes("SÌ") || answer === "YES";
    } catch (e) {
        console.error("[Item Reconcile] ❌ Errore AI confirm:", e);
        return false;
    }
}

/**
 * Trova il nome canonico se esiste un oggetto simile nell'inventario.
 */
export async function reconcileItemName(
    campaignId: number,
    newItem: string
): Promise<{ canonicalName: string; existingItem: any } | null> {
    const existingItems = listAllInventory(campaignId);
    if (existingItems.length === 0) return null;

    const newItemLower = newItem.toLowerCase().trim();

    // Match esatto
    const exactMatch = existingItems.find((i: any) => i.item_name.toLowerCase() === newItemLower);
    if (exactMatch) return null;

    // Cerca candidati
    const candidates: Array<{ item: any; similarity: number; reason: string }> = [];

    for (const item of existingItems) {
        const existingName = item.item_name;
        const similarity = levenshteinSimilarity(newItem, existingName);

        if (similarity >= 0.65) {
            candidates.push({ item, similarity, reason: `levenshtein=${similarity.toFixed(2)}` });
            continue;
        }

        if (containsSubstring(newItem, existingName)) {
            candidates.push({ item, similarity: 0.75, reason: 'substring_match' });
        }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.similarity - a.similarity);

    for (const candidate of candidates.slice(0, 3)) {
        console.log(`[Item Reconcile] 🔍 "${newItem}" simile a "${candidate.item.item_name}" (${candidate.reason}). Chiedo conferma AI...`);

        const isSame = await aiConfirmSameItem(newItem, candidate.item.item_name);

        if (isSame) {
            console.log(`[Item Reconcile] ✅ CONFERMATO: "${newItem}" = "${candidate.item.item_name}"`);
            return { canonicalName: candidate.item.item_name, existingItem: candidate.item };
        } else {
            console.log(`[Item Reconcile] ❌ "${newItem}" ≠ "${candidate.item.item_name}"`);
        }
    }

    return null;
}

/**
 * Pre-deduplica un batch di loot.
 */
export async function deduplicateItemBatch(
    items: string[]
): Promise<string[]> {
    if (items.length <= 1) return items;

    const result: string[] = [];
    const processed = new Set<number>();

    for (let i = 0; i < items.length; i++) {
        if (processed.has(i)) continue;

        let merged = items[i];
        processed.add(i);

        for (let j = i + 1; j < items.length; j++) {
            if (processed.has(j)) continue;

            const similarity = levenshteinSimilarity(merged, items[j]);
            const hasSubstring = containsSubstring(merged, items[j]);

            if (similarity > 0.7 || hasSubstring) {
                const isSame = await aiConfirmSameItem(merged, items[j]);

                if (isSame) {
                    console.log(`[Item Batch Dedup] 🔄 "${items[j]}" → "${merged}"`);
                    // Usa nome più lungo/descrittivo
                    if (items[j].length > merged.length) {
                        merged = items[j];
                    }
                    processed.add(j);
                }
            }
        }

        result.push(merged);
    }

    if (result.length < items.length) {
        console.log(`[Item Batch Dedup] ✅ Ridotti ${items.length} oggetti a ${result.length}`);
    }

    return result;
}

// =============================================
// === QUEST RECONCILIATION ===
// =============================================

/**
 * Chiede all'AI se due quest sono la stessa missione.
 */
async function aiConfirmSameQuest(title1: string, title2: string, context: string = ""): Promise<boolean> {
    const prompt = `Sei un esperto di D&D e missioni. Rispondi SOLO con "SI" o "NO".

Domanda: "${title1}" e "${title2}" sono la STESSA missione/quest?

Considera che:
- I titoli potrebbero essere varianti (es. "Salvare il villaggio" = "Salvare il Villaggio")
- Potrebbero essere abbreviati (es. "Trova l'artefatto" ≈ "Trovare l'artefatto antico")
- NON unire missioni diverse (es. "Salvare Alice" ≠ "Salvare Bob")

${context ? `Contesto: ${context}` : ''}

Rispondi SOLO: SI oppure NO`;

    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 5
        });
        const answer = response.choices[0].message.content?.toUpperCase().trim() || "";
        return answer.includes("SI") || answer.includes("SÌ") || answer === "YES";
    } catch (e) {
        console.error("[Quest Reconcile] ❌ Errore AI confirm:", e);
        return false;
    }
}

/**
 * Trova il titolo canonico se esiste una quest simile.
 */
export async function reconcileQuestTitle(
    campaignId: number,
    newTitle: string
): Promise<{ canonicalTitle: string; existingQuest: any } | null> {
    const existingQuests = listAllQuests(campaignId);
    if (existingQuests.length === 0) return null;

    const newTitleLower = newTitle.toLowerCase().trim();

    // Match esatto
    const exactMatch = existingQuests.find((q: any) => q.title.toLowerCase() === newTitleLower);
    if (exactMatch) return null;

    // Cerca candidati
    const candidates: Array<{ quest: any; similarity: number; reason: string }> = [];

    for (const quest of existingQuests) {
        const existingTitle = quest.title;
        const similarity = levenshteinSimilarity(newTitle, existingTitle);

        if (similarity >= 0.6) {
            candidates.push({ quest, similarity, reason: `levenshtein=${similarity.toFixed(2)}` });
            continue;
        }

        if (containsSubstring(newTitle, existingTitle)) {
            candidates.push({ quest, similarity: 0.7, reason: 'substring_match' });
        }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.similarity - a.similarity);

    for (const candidate of candidates.slice(0, 3)) {
        console.log(`[Quest Reconcile] 🔍 "${newTitle}" simile a "${candidate.quest.title}" (${candidate.reason}). Chiedo conferma AI...`);

        const isSame = await aiConfirmSameQuest(newTitle, candidate.quest.title);

        if (isSame) {
            console.log(`[Quest Reconcile] ✅ CONFERMATO: "${newTitle}" = "${candidate.quest.title}"`);
            return { canonicalTitle: candidate.quest.title, existingQuest: candidate.quest };
        } else {
            console.log(`[Quest Reconcile] ❌ "${newTitle}" ≠ "${candidate.quest.title}"`);
        }
    }

    return null;
}

/**
 * Pre-deduplica un batch di quest.
 */
export async function deduplicateQuestBatch(
    quests: Array<{ title: string; status?: string }>
): Promise<Array<{ title: string; status?: string }>> {
    if (quests.length <= 1) return quests;

    const result: typeof quests = [];
    const processed = new Set<number>();

    for (let i = 0; i < quests.length; i++) {
        if (processed.has(i)) continue;

        let merged = { ...quests[i] };
        processed.add(i);

        for (let j = i + 1; j < quests.length; j++) {
            if (processed.has(j)) continue;

            const similarity = levenshteinSimilarity(merged.title, quests[j].title);
            const hasSubstring = containsSubstring(merged.title, quests[j].title);

            if (similarity > 0.65 || hasSubstring) {
                const isSame = await aiConfirmSameQuest(merged.title, quests[j].title);

                if (isSame) {
                    console.log(`[Quest Batch Dedup] 🔄 "${quests[j].title}" → "${merged.title}"`);
                    // Usa titolo più lungo
                    if (quests[j].title.length > merged.title.length) {
                        merged.title = quests[j].title;
                    }
                    // Status più avanzato
                    if (quests[j].status === 'COMPLETED' || quests[j].status === 'FAILED') {
                        merged.status = quests[j].status;
                    }
                    processed.add(j);
                }
            }
        }

        result.push(merged);
    }

    if (result.length < quests.length) {
        console.log(`[Quest Batch Dedup] ✅ Ridotte ${quests.length} quest a ${result.length}`);
    }

    return result;
}

// --- RAG: SYNC DOSSIER ---
export async function syncNpcDossier(campaignId: number, npcName: string, description: string, role: string | null, status: string | null) {
    const content = `DOSSIER NPC: ${npcName}. RUOLO: ${role || 'Sconosciuto'}. STATO: ${status || 'Sconosciuto'}. DESCRIZIONE: ${description}`;
    console.log(`[RAG] 🔄 Sync Dossier per ${npcName}...`);

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
                    campaignId, 'DOSSIER_SYNC', content,
                    val.data,
                    val.provider === 'openai' ? EMBEDDING_MODEL_OPENAI : EMBEDDING_MODEL_OLLAMA,
                    Date.now(), // timestamp corrente
                    null, // macro
                    null, // micro
                    [npcName] // associamo esplicitamente il NPC
                );
            }
        }
    }
}

// ============================================
// EXPORTS FOR NARRATIVE FILTER
// ============================================

export {
    narrativeFilterClient,
    NARRATIVE_FILTER_MODEL,
    NARRATIVE_FILTER_PROVIDER,
    NARRATIVE_BATCH_SIZE
};