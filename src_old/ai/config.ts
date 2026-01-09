import OpenAI from 'openai';
import 'dotenv/config';

// --- CONFIGURAZIONE TONI ---
export const TONES = {
    EPICO: "Sei un cantastorie epico. Usa un linguaggio epico, solenne, enfatizza l'eroismo e il destino.",
    DIVERTENTE: "Sei un bardo ubriaco e sarcastico. Prendi in giro i fallimenti dei personaggi.",
    OSCURO: "Sei un cronista di un mondo Lovecraftiano. Tono cupo e disperato.",
    CONCISO: "Sei un segretario efficiente. solo fatti narrazione in terza persona.",
    DM: "Sei un assistente per il Dungeon Master. Punti salienti, loot e NPC."
};

export type ToneKey = keyof typeof TONES;

// Configurazione Provider
export const useOllama = process.env.AI_PROVIDER === 'ollama';

// --- CONFIGURAZIONE LIMITI (DINAMICA) ---
export const MAX_CHUNK_SIZE = useOllama ? 15000 : 800000;
export const CHUNK_OVERLAP = useOllama ? 1000 : 5000;

// MODEL_NAME = Modello "Smart" (Costoso, per prosa finale - REDUCE)
export const MODEL_NAME = useOllama ? (process.env.OLLAMA_MODEL || "llama3.2") : (process.env.OPEN_AI_MODEL || "gpt-5.2");

// FAST_MODEL_NAME = Modello "Fast" (Economico, per MAP, CHAT e CORREZIONI)
export const FAST_MODEL_NAME = useOllama ? MODEL_NAME : (process.env.OPEN_AI_MODEL_MINI || "gpt-5-mini");

// CONFIGURAZIONE CORREZIONE TRASCRIZIONE
export const TRANSCRIPTION_PROVIDER = process.env.TRANSCRIPTION_PROVIDER || 'ollama'; // 'ollama' oppure 'openai'
export const ENABLE_AI_TRANSCRIPTION_CORRECTION = process.env.ENABLE_AI_TRANSCRIPTION_CORRECTION !== 'false'; // Default true
export const OPEN_AI_MODEL_NANO = process.env.OPEN_AI_MODEL_NANO || 'gpt-5-nano'; // Modello economico per OpenAI

// Concurrency: 1 per locale, 5 per Cloud
export const CONCURRENCY_LIMIT = useOllama ? 1 : 5;

// URL Base
export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434/v1';

// --- CLIENTS ---

// 1. Client OpenAI Reale (sempre OpenAI)
export const openAiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    project: process.env.OPENAI_PROJECT_ID,
    timeout: 600 * 1000,
});

// 2. Client Ollama Reale (sempre Ollama)
export const ollamaClient = new OpenAI({
    baseURL: OLLAMA_BASE_URL,
    apiKey: 'ollama',
    timeout: 600 * 1000,
});

// 3. Client Principale (Alias dinamico per il resto dell'app)
export const openai = useOllama ? ollamaClient : openAiClient;

// 4. Client Locale (Alias per retrocompatibilità, punta a Ollama)
export const localClient = ollamaClient;

export const LOCAL_CORRECTION_MODEL = process.env.OLLAMA_MODEL || "llama3.2";

// --- CLIENT DEDICATI PER EMBEDDING ---
export const openaiEmbedClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'dummy',
    project: process.env.OPENAI_PROJECT_ID,
});

export const ollamaEmbedClient = new OpenAI({
    baseURL: OLLAMA_BASE_URL,
    apiKey: 'ollama',
});

export const EMBEDDING_MODEL_OPENAI = "text-embedding-3-small";
export const EMBEDDING_MODEL_OLLAMA = "nomic-embed-text";

/**
 * Divide il testo in chunk
 */
export function splitTextInChunks(text: string, chunkSize: number = MAX_CHUNK_SIZE, overlap: number = CHUNK_OVERLAP): string[] {
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
export async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
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
export async function processInBatches<T, R>(
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

            // Logghiamo sempre se i batch sono pochi (<50), altrimenti ogni 5 step per non intasare
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
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
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
