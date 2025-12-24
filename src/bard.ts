import OpenAI from 'openai';
import {getSessionTranscript, getUserProfile, getSessionErrors, getSessionStartTime} from './db';

// --- CONFIGURAZIONE TONI ---
export const TONES = {
    EPICO: "Sei un cantastorie epico. Usa un linguaggio arcaico, solenne, enfatizza l'eroismo e il destino.",
    DIVERTENTE: "Sei un bardo ubriaco e sarcastico. Prendi in giro i fallimenti dei personaggi.",
    OSCURO: "Sei un cronista di un mondo Lovecraftiano. Tono cupo e disperato.",
    CONCISO: "Sei un segretario efficiente. Elenco puntato, solo fatti.",
    DM: "Sei un assistente per il Dungeon Master. Punti salienti, loot e NPC."
};

export type ToneKey = keyof typeof TONES;

// Configurazione Provider
const useOllama = process.env.AI_PROVIDER === 'ollama';

// --- CONFIGURAZIONE LIMITI (DINAMICA) ---
// Se usiamo Ollama (Llama 3), teniamo chunk piccoli per non saturare la context window (spesso 8k o 128k ma fragile).
// Se usiamo OpenAI (GPT-4o), usiamo chunk enormi (800k) per sfruttare la context window di 128k+ token.
const MAX_CHUNK_SIZE = useOllama ? 15000 : 800000;
const CHUNK_OVERLAP = useOllama ? 1000 : 5000;

// Nota: Su Oracle A1, "llama3.1" (8B) potrebbe essere lento ma più intelligente. 
// "llama3.2" (3B) è velocissimo ma meno dettagliato. Fai dei test.
const MODEL_NAME = useOllama ? (process.env.OLLAMA_MODEL || "llama3.2") : (process.env.OPEN_AI_MODEL || "gpt-4o-mini");

// Concurrency: 1 per locale, 5 per Cloud
const CONCURRENCY_LIMIT = useOllama ? 1 : 5;

// URL Base: Gestione intelligente del default in base all'ambiente
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434/v1';

const openai = new OpenAI({
    baseURL: useOllama ? OLLAMA_BASE_URL : undefined,
    apiKey: useOllama ? 'ollama' : process.env.OPENAI_API_KEY,
    timeout: 600 * 1000, 
});

/**
 * Divide il testo in chunk
 * I default sono ora dinamici in base al provider scelto.
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
    } catch (err) {
        if (retries <= 0) throw err;
        console.warn(`[Bardo] ⚠️ Errore API (Tentativi rimasti: ${retries}). Riprovo tra ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return withRetry(fn, retries - 1, delay * 2);
    }
}

/**
 * Batch Processing per rispettare i limiti di concorrenza
 */
async function processInBatches<T, R>(items: T[], batchSize: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        console.log(`[Bardo] ⚙️  Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(items.length/batchSize)} (Size: ${batch.length})`);
        const batchResults = await Promise.all(batch.map((item, batchIndex) => fn(item, i + batchIndex)));
        results.push(...batchResults);
    }
    return results;
}

// --- FASE 1: MAP ---
// Modificato: Restituisce testo + token
async function extractFactsFromChunk(chunk: string, index: number, total: number, castContext: string): Promise<{text: string, tokens: number}> {
    console.log(`[Bardo] 🗺️  Fase MAP: Analisi chunk ${index + 1}/${total} (${chunk.length} chars)...`);
    
    const mapPrompt = `Sei un analista di D&D.
    ${castContext}
    Estrai un elenco puntato cronologico di: Combattimenti, Dialoghi Importanti, Loot, Lore.
    Sii conciso. Se non succede nulla, scrivi "Nessun evento".`;

    try {
        const response = await withRetry(() => openai.chat.completions.create({
            model: MODEL_NAME,
            messages: [
                { role: "system", content: mapPrompt },
                { role: "user", content: chunk }
            ],
        }));
        
        return {
            text: response.choices[0].message.content || "",
            tokens: response.usage?.total_tokens || 0
        };
    } catch (err) {
        console.error(`[Bardo] ❌ Errore Map chunk ${index + 1}:`, err);
        return { text: "", tokens: 0 }; 
    }
}

// --- FUNZIONE PRINCIPALE ---
// Modificato: Restituisce oggetto con summary e token totali
export async function generateSummary(sessionId: string, tone: ToneKey = 'DM'): Promise<{summary: string, tokens: number}> {
    console.log(`[Bardo] 📚 Recupero trascrizioni per sessione ${sessionId} (Model: ${MODEL_NAME})...`);
    console.log(`[Bardo] ⚙️  Configurazione: Chunk Size=${MAX_CHUNK_SIZE}, Overlap=${CHUNK_OVERLAP}, Provider=${useOllama ? 'Ollama' : 'OpenAI'}`);
    
    const transcriptions = getSessionTranscript(sessionId);
    const startTime = getSessionStartTime(sessionId) || 0;

    if (transcriptions.length === 0) return { summary: "Nessuna trascrizione trovata.", tokens: 0 };

    // Context Personaggi
    const userIds = new Set(transcriptions.map(t => t.user_id));
    let castContext = "PERSONAGGI (Usa queste info per arricchire la narrazione):\n";
    
    userIds.forEach(uid => {
        const p = getUserProfile(uid);
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

    // --- RICOSTRUZIONE INTELLIGENTE (DIARIZZAZIONE) ---
    interface DialogueFragment {
        absoluteTime: number;
        character: string;
        text: string;
    }

    const allFragments: DialogueFragment[] = [];

    for (const t of transcriptions) {
        try {
            const segments = JSON.parse(t.transcription_text);
            if (Array.isArray(segments)) {
                for (const seg of segments) {
                    allFragments.push({
                        absoluteTime: t.timestamp + (seg.start * 1000),
                        character: t.character_name || "Sconosciuto",
                        text: seg.text
                    });
                }
            } else { throw new Error("Formato JSON non valido"); }
        } catch (e) {
            allFragments.push({
                absoluteTime: t.timestamp,
                character: t.character_name || "Sconosciuto",
                text: t.transcription_text
            });
        }
    }

    allFragments.sort((a, b) => a.absoluteTime - b.absoluteTime);

    let fullDialogue = allFragments
        .map(f => {
            const minutes = Math.floor((f.absoluteTime - startTime) / 60000);
            const seconds = Math.floor(((f.absoluteTime - startTime) % 60000) / 1000);
            const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
            return `[${timeStr}] ${f.character}: ${f.text}`;
        })
        .join("\n");

    // Usiamo la costante dinamica per decidere se attivare Map-Reduce
    let contextForFinalStep = "";
    let accumulatedTokens = 0;

    if (fullDialogue.length > MAX_CHUNK_SIZE) {
        console.log(`[Bardo] 🐘 Testo lungo (${fullDialogue.length} chars > ${MAX_CHUNK_SIZE}). Attivo Map-Reduce.`);
        
        const chunks = splitTextInChunks(fullDialogue, MAX_CHUNK_SIZE, CHUNK_OVERLAP);
        console.log(`[Bardo] 🔪 Diviso in ${chunks.length} segmenti. Concorrenza: ${CONCURRENCY_LIMIT}`);

        const mapResults = await processInBatches(chunks, CONCURRENCY_LIMIT, (chunk, index) => 
            extractFactsFromChunk(chunk, index, chunks.length, castContext)
        );

        contextForFinalStep = mapResults.map(r => r.text).join("\n\n--- SEGMENTO SUCCESSIVO ---\n\n");
        accumulatedTokens = mapResults.reduce((acc, curr) => acc + curr.tokens, 0);
    } else {
        contextForFinalStep = fullDialogue;
    }

    // --- FASE 2: REDUCE ---
    console.log(`[Bardo] ✍️  Fase REDUCE: Generazione racconto...`);
    
    const reducePrompt = `Sei un Bardo. ${TONES[tone]}
    ${castContext}
    Usa gli appunti seguenti per scrivere un riassunto coerente della sessione.
    Includi un titolo.`;

    try {
        const response = await withRetry(() => openai.chat.completions.create({
            model: MODEL_NAME,
            messages: [
                { role: "system", content: reducePrompt },
                { role: "user", content: contextForFinalStep }
            ],
        }));

        const finalSummary = response.choices[0].message.content || "Errore generazione.";
        accumulatedTokens += response.usage?.total_tokens || 0;

        return {
            summary: finalSummary,
            tokens: accumulatedTokens
        };
    } catch (err: any) {
        console.error("Errore finale:", err);
        throw err;
    }
}
