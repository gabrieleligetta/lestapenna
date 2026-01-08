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
const useOllama = process.env.AI_PROVIDER === 'ollama';

// --- CONFIGURAZIONE LIMITI (DINAMICA) ---
const MAX_CHUNK_SIZE = useOllama ? 15000 : 800000;
const CHUNK_OVERLAP = useOllama ? 1000 : 5000;

// MODEL_NAME = Modello "Smart" (Costoso, per prosa finale - REDUCE)
// Default su GPT-5.2 se non specificato diversamente
const MODEL_NAME = useOllama ? (process.env.OLLAMA_MODEL || "llama3.2") : (process.env.OPEN_AI_MODEL || "gpt-5.2");

// FAST_MODEL_NAME = Modello "Fast" (Economico, per MAP, CHAT e CORREZIONI)
// Default su GPT-5-mini per risparmiare token e tempo
const FAST_MODEL_NAME = useOllama ? MODEL_NAME : (process.env.OPEN_AI_MODEL_MINI || "gpt-5-mini");

// Concurrency: 1 per locale, 5 per Cloud
const CONCURRENCY_LIMIT = useOllama ? 1 : 5;

// URL Base
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434/v1';

// Client Principale (Chat)
const openai = new OpenAI({
    baseURL: useOllama ? OLLAMA_BASE_URL : undefined,
    project: useOllama ? undefined : process.env.OPENAI_PROJECT_ID,
    apiKey: useOllama ? 'ollama' : process.env.OPENAI_API_KEY,
    timeout: 600 * 1000,
});

// --- CLIENT DEDICATO PER CORREZIONE LOCALE (IBRIDO) ---
const localClient = new OpenAI({
    baseURL: OLLAMA_BASE_URL,
    apiKey: 'ollama', // Ollama non richiede vera API key
});
const LOCAL_CORRECTION_MODEL = process.env.OLLAMA_MODEL || "llama3.2";

// --- CLIENT DEDICATI PER EMBEDDING ---
const openaiEmbedClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'dummy',
    project: process.env.OPENAI_PROJECT_ID,
});

const ollamaEmbedClient = new OpenAI({
    baseURL: OLLAMA_BASE_URL,
    apiKey: 'ollama',
});

const EMBEDDING_MODEL_OPENAI = "text-embedding-3-small";
const EMBEDDING_MODEL_OLLAMA = "nomic-embed-text";

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
    present_npcs?: string[]; // Lista semplice di NPC presenti nella scena
}

// Interfaccia per il riassunto strutturato
export interface SummaryResponse {
    summary: string;
    title: string;
    tokens: number;
    loot?: string[];
    loot_removed?: string[]; // NUOVO: Oggetti consumati/persi
    quests?: string[];
    narrative?: string; // NUOVO: Racconto narrativo
    log?: string[]; // NUOVO: Log schematico
    // NUOVO CAMPO
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
 * @param items Array di elementi da processare
 * @param batchSize Quanti elementi processare in parallelo
 * @param fn Funzione da eseguire per ogni elemento
 * @param taskName Nome del task per il log (es. "Correzione", "Embeddings")
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
    const mapPrompt = `Sei un analista di D&D.
    ${castContext}
    Estrai un elenco puntato cronologico strutturato esattamente così:
    1. Nomi di NPC incontrati e le frasi chiave che hanno pronunciato (anche se lette dalla voce del DM);
    2. Luoghi visitati;
    3. Oggetti ottenuti (Loot) con dettagli;
    4. Numeri/Danni rilevanti;
    5. Decisioni chiave dei giocatori.
    6. Dialoghi importanti e il loro contenuto.
    
    Sii conciso. Se per una categoria non ci sono dati, scrivi "Nessuno".`;

    try {
        const response = await withRetry(() => openai.chat.completions.create({
            model: FAST_MODEL_NAME, // USA IL MODELLO VELOCE ED ECONOMICO
            messages: [
                { role: "system", content: mapPrompt },
                { role: "user", content: chunk }
            ],
        }));

        return {
            text: response.choices[0].message.content || "",
            title: "", // Placeholder, il titolo viene generato nella fase REDUCE
            tokens: response.usage?.total_tokens || 0
        };
    } catch (err) {
        console.error(`[Bardo] ❌ Errore Map chunk ${index + 1}:`, err);
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

    console.log(`[RAG] 🧠 Ingestione RAW per sessione ${sessionId}...`);

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
            
            // NOTA: t.character_name è già il risultato di COALESCE(snapshot, current) dalla query SQL in db.ts
            // Quindi qui stiamo usando correttamente l'identità storica se disponibile.
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

    // 2b. Recupera lista NPC per tagging (fallback se present_npcs è vuoto)
    const allNpcs = listNpcs(campaignId, 1000); // Recupera tutti gli NPC
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

        // Recuperiamo il luogo e gli NPC dal primo segmento del chunk (approssimazione accettabile)
        // Cerchiamo la riga corrispondente nel array originale
        const firstLine = lines.find(l => l.text.includes(chunkText.substring(0, 50)));
        const macro = firstLine?.macro || null;
        const micro = firstLine?.micro || null;
        
        // MERGE INTELLIGENTE NPC:
        // Uniamo gli NPC esplicitamente taggati nel DB (present_npcs) con quelli trovati nel testo
        const dbNpcs = firstLine?.present_npcs || [];
        const textNpcs = npcNames.filter(name => chunkText.toLowerCase().includes(name.toLowerCase()));
        const mergedNpcs = Array.from(new Set([...dbNpcs, ...textNpcs]));

        if (chunkText.length > 50) chunks.push({ text: chunkText, timestamp: chunkTimestamp, macro, micro, npcs: mergedNpcs });
        if (end >= fullText.length) break;
        i = end - OVERLAP;
    }

    // 4. Embedding con Progress Bar
    // Usiamo una concorrenza sicura per gli embedding (5 richieste parallele)
    await processInBatches(chunks, 5, async (chunk, idx) => {
        const promises = [];

        // OpenAI Task
        promises.push(
            openaiEmbedClient.embeddings.create({ model: EMBEDDING_MODEL_OPENAI, input: chunk.text })
                .then(resp => ({ provider: 'openai', data: resp.data[0].embedding }))
                .catch(err => ({ provider: 'openai', error: err.message }))
        );

        // Ollama Task
        promises.push(
            ollamaEmbedClient.embeddings.create({ model: EMBEDDING_MODEL_OLLAMA, input: chunk.text })
                .then(resp => ({ provider: 'ollama', data: resp.data[0].embedding }))
                .catch(err => ({ provider: 'ollama', error: err.message }))
        );

        const results = await Promise.allSettled(promises);

        for (const res of results) {
            if (res.status === 'fulfilled') {
                const val = res.value as any;
                if (!val.error) {
                    insertKnowledgeFragment(
                        campaignId, sessionId, chunk.text, val.data,
                        val.provider === 'openai' ? EMBEDDING_MODEL_OPENAI : EMBEDDING_MODEL_OLLAMA,
                        chunk.timestamp,
                        chunk.macro,
                        chunk.micro,
                        chunk.npcs
                    );
                }
            }
        }
    }, "Calcolo Embeddings (RAG)");
}

// --- RAG: SEARCH ---
export async function searchKnowledge(campaignId: number, query: string, limit: number = 5): Promise<string[]> {
    const provider = process.env.EMBEDDING_PROVIDER || process.env.AI_PROVIDER || 'openai';
    const isOllama = provider === 'ollama';
    const model = isOllama ? EMBEDDING_MODEL_OLLAMA : EMBEDDING_MODEL_OPENAI;
    const client = isOllama ? ollamaEmbedClient : openaiEmbedClient;

    console.log(`[RAG] 🔍 Ricerca con modello: ${model} (${provider})`);

    try {
        // 1. Calcolo Embedding Query
        const resp = await client.embeddings.create({ model: model, input: query });
        const queryVector = resp.data[0].embedding;
        
        // 2. Recupero Frammenti (già ordinati per timestamp ASC dal DB)
        let fragments = getKnowledgeFragments(campaignId, model);
        if (fragments.length === 0) return [];

        // --- RAG INVESTIGATIVO (Cross-Ref) ---
        // Identifichiamo se la query menziona NPC specifici per filtrare i risultati
        const allNpcs = listNpcs(campaignId, 1000);
        const mentionedNpcs = allNpcs.filter(npc => query.toLowerCase().includes(npc.name.toLowerCase()));
        
        if (mentionedNpcs.length > 0) {
            console.log(`[RAG] 🕵️ Rilevati NPC nella query: ${mentionedNpcs.map(n => n.name).join(', ')}. Attivo filtro investigativo.`);
            
            // Filtriamo i frammenti: teniamo solo quelli che hanno ALMENO UNO degli NPC menzionati
            // nella colonna associated_npcs
            const filteredFragments = fragments.filter(f => {
                if (!f.associated_npcs) return false;
                const fragmentNpcs = f.associated_npcs.split(',').map(n => n.toLowerCase());
                return mentionedNpcs.some(mn => fragmentNpcs.includes(mn.name.toLowerCase()));
            });

            // Se il filtro è troppo aggressivo (0 risultati), torniamo al set completo (fallback)
            if (filteredFragments.length > 0) {
                console.log(`[RAG] 📉 Filtro applicato: da ${fragments.length} a ${filteredFragments.length} frammenti.`);
                fragments = filteredFragments;
            } else {
                console.log(`[RAG] ⚠️ Filtro investigativo ha prodotto 0 risultati. Fallback su ricerca completa.`);
            }
        }
        // -------------------------------------

        // 3. Recupero Contesto Attuale (per Boosting)
        const currentLocation = getCampaignLocationById(campaignId);
        const currentMacro = currentLocation?.macro || "";
        const currentMicro = currentLocation?.micro || "";

        // 4. Scoring & Boosting
        const scored = fragments.map((f, index) => {
            const vector = JSON.parse(f.embedding_json);
            let score = cosineSimilarity(queryVector, vector);

            // Boost Contestuale: Se il ricordo è avvenuto nel luogo dove sono ora, aumento la rilevanza
            if (currentMacro && f.macro_location === currentMacro) score += 0.05;
            if (currentMicro && f.micro_location === currentMicro) score += 0.10;

            return { ...f, score, originalIndex: index };
        });

        // 5. Ordinamento per Rilevanza
        scored.sort((a, b) => b.score - a.score);

        // 6. Selezione Top K + Espansione Temporale ("Cosa succede prima e dopo?")
        const topK = scored.slice(0, limit);
        const finalIndices = new Set<number>();

        topK.forEach(item => {
            finalIndices.add(item.originalIndex);
            
            // Espansione CAUSALE (Prima) - Solo se stessa sessione
            if (item.originalIndex - 1 >= 0) {
                const prev = fragments[item.originalIndex - 1];
                if (prev.session_id === item.session_id) {
                    finalIndices.add(item.originalIndex - 1);
                }
            }

            // Espansione CONSEGUENZIALE (Dopo) - Solo se stessa sessione
            if (item.originalIndex + 1 < fragments.length) {
                const next = fragments[item.originalIndex + 1];
                if (next.session_id === item.session_id) {
                    finalIndices.add(item.originalIndex + 1);
                }
            }
        });

        // 7. Recupero Finale Ordinato Cronologicamente
        // È cruciale che l'AI legga la storia in ordine temporale, non di rilevanza
        const finalFragments = Array.from(finalIndices)
            .sort((a, b) => a - b) // Ordina per indice (che corrisponde al timestamp)
            .map(idx => fragments[idx].content);

        return finalFragments;

    } catch (e) {
        console.error("[RAG] ❌ Errore ricerca:", e);
        return [];
    }
}

// --- RAG: ASK BARD ---
export async function askBard(campaignId: number, question: string, history: { role: 'user' | 'assistant', content: string }[] = []): Promise<string> {
    const context = await searchKnowledge(campaignId, question, 5);
    
    // SAFETY CHECK: Troncatura contesto per evitare overflow token
    let contextText = context.length > 0
        ? "TRASCRIZIONI RILEVANTI (FONTE DI VERITÀ):\n" + context.map(c => `...\\n${c}\\n...`).join("\\n")
        : "Nessuna memoria specifica trovata.";

    const MAX_CONTEXT_CHARS = 12000;
    if (contextText.length > MAX_CONTEXT_CHARS) {
        console.warn(`[Bardo] ⚠️ Contesto troppo lungo (${contextText.length} chars). Troncatura di sicurezza.`);
        contextText = contextText.substring(0, MAX_CONTEXT_CHARS) + "\n... [TESTO TRONCATO PER LIMITI DI MEMORIA]";
    }

    // --- GENIUS LOCI: Adattamento Tono ---
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
    // -------------------------------------

    // --- RAG SOCIALE: Iniezione Dossier NPC ---
    const relevantNpcs = findNpcDossierByName(campaignId, question);
    let socialContext = "";
    
    if (relevantNpcs.length > 0) {
        socialContext = "\n\n[[DOSSIER PERSONAGGI RILEVANTI]]\n";
        relevantNpcs.forEach((npc: any) => {
            socialContext += `- NOME: ${npc.name}\n  RUOLO: ${npc.role || 'Sconosciuto'}\n  STATO: ${npc.status}\n  INFO: ${npc.description}\n`;
        });
        socialContext += "Usa queste informazioni per arricchire la risposta, ma dai priorità ai fatti accaduti nelle trascrizioni.\n";
    }
    // ------------------------------------------

    // Prompt Ricco Ripristinato
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

    try {
        const response = await withRetry(() => openai.chat.completions.create({
            model: FAST_MODEL_NAME, // Fast per le chat
            messages: messages as any
        }));
        return response.choices[0].message.content || "Il Bardo è muto.";
    } catch (e) {
        console.error("[Bardo] Errore risposta:", e);
        return "La mia mente è annebbiata...";
    }
}

// --- CORREZIONE TRASCRIZIONE ---
export async function correctTranscription(segments: any[], campaignId?: number): Promise<AIResponse> {
    // 1. Costruzione Contesto (una tantum)
    let contextInfo = "Contesto: Sessione di gioco di ruolo (Dungeons & Dragons).";
    let currentLocationMsg = "Luogo attuale: Sconosciuto.";
    let atlasContext = "";
    let currentMacro = "";
    let currentMicro = "";

    if (campaignId) {
        const campaign = getCampaignById(campaignId);
        if (campaign) {
            contextInfo += `\nCampagna: "${campaign.name}".`;
            
            // @ts-ignore (se TS si lamenta dei campi nuovi non ancora nell'interfaccia type Campaign)
            const loc: LocationState = { macro: campaign.current_macro_location, micro: campaign.current_micro_location };
            
            if (loc.macro || loc.micro) {
                currentMacro = loc.macro || "";
                currentMicro = loc.micro || "";
                
                currentLocationMsg = `LUOGO ATTUALE CONOSCIUTO:
                - Macro-Regione/Città: "${loc.macro || 'Non specificato'}"
                - Micro-Luogo (Stanza/Edificio): "${loc.micro || 'Non specificato'}"`;

                // RECUPERO MEMORIA ATLANTE
                if (currentMacro && currentMicro) {
                    const lore = getAtlasEntry(campaignId, currentMacro, currentMicro);
                    if (lore) {
                        atlasContext = `\n\n[[MEMORIA DEL LUOGO (ATLANTE)]]\nEcco cosa sappiamo già di questo posto:\n"${lore}"\nUsa queste info per riconoscere nomi e contesto.`;
                    } else {
                        atlasContext = `\n\n[[MEMORIA DEL LUOGO (ATLANTE)]]\nNon abbiamo ancora informazioni su questo luogo. Se vengono descritti dettagli importanti (NPC, atmosfera, oggetti chiave), annotali.`;
                    }
                }
            }

            const characters = getCampaignCharacters(campaignId);
            if (characters.length > 0) {
                contextInfo += "\nPersonaggi Giocanti (PG):";
                characters.forEach(c => {
                    if (c.character_name) {
                        let charDesc = `\n- ${c.character_name}`;
                        if (c.race || c.class) charDesc += ` (${[c.race, c.class].filter(Boolean).join(' ')})`;
                        contextInfo += charDesc;
                    }
                });
            }
        }
    }

    // 2. Prepariamo i batch (gruppi di segmenti)
    const BATCH_SIZE = 20;
    const allBatches: any[][] = [];
    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
        allBatches.push(segments.slice(i, i + BATCH_SIZE));
    }

    // 3. Usiamo la funzione centralizzata processInBatches per gestire parallelismo e progress bar
    const results = await processInBatches(allBatches, CONCURRENCY_LIMIT, async (batch, idx) => {
        const batchInput = { segments: batch };

        // Prompt Ricco Ripristinato
        const prompt = `Sei l'assistente ufficiale di trascrizione per una campagna di D&D.
${contextInfo}
${currentLocationMsg}
${atlasContext}

OBIETTIVI:
1. Correggere la trascrizione fornita (nomi propri, incantesimi, punteggiatura).
2. [CARTOGRAFO] Rilevare se i personaggi si SPOSTANO fisicamente in un nuovo luogo.
   - **Macro-Luogo**: Cambia solo se viaggiano tra città, regioni o piani (es. da "Neverwinter" a "Waterdeep").
   - **Micro-Luogo**: Cambia se entrano in un edificio, una stanza o un'area specifica (es. da "Strada" a "Taverna").
3. [STORICO] Aggiorna la descrizione del luogo ATTUALE nell'Atlante SE:
   - Ci sono nuovi dettagli significativi (nomi NPC, stato della stanza, eventi chiave).
   - O se la descrizione vecchia è obsoleta.
   - Sii conciso ma descrittivo. Se non cambia nulla di rilevante, lascia 'atlas_update' vuoto.
4. [BIOGRAFO] Rilevare informazioni sugli NPC (Non-Player Characters).
   - Se viene introdotto un nuovo NPC (es. "Sono il capitano Vane"), estrai nome e ruolo.
   - Se un NPC subisce un cambiamento drastico (es. muore, si rivela un traditore), aggiorna lo status o la descrizione.
   - Ignora i Personaggi Giocanti (PG) già noti.
5. [OSSERVATORE] Elenca TUTTI gli NPC presenti nella scena (anche se non parlano ma vengono nominati come presenti).
   - Restituisci una lista semplice di nomi in "present_npcs".

REGOLE CARTOGRAFO:
- Se rimangono dove sono, NON includere "detected_location" nel JSON.
- Se si spostano, cerca di dedurre sia il Macro che il Micro. Se il Macro non cambia, ripeti quello attuale o lascialo null.
- Sii conservativo: cambia luogo solo se i giocatori dicono esplicitamente "Andiamo alla Taverna", "Entriamo nel dungeon", etc.

ISTRUZIONI SPECIFICHE PER LA CORREZIONE:
1. Rimuovi riempitivi verbali come "ehm", "uhm", "cioè", ripetizioni inutili e balbettii.
2. Correggi i termini tecnici di D&D (es. incantesimi, mostri) usando la grafia corretta (es. "Dardo Incantato" invece di "dardo incantato").
3. [IMPORTANTE] Rileva ed ELIMINA le "allucinazioni" di Whisper: se un segmento contiene frasi come "Sottotitoli creati dalla comunità", "Amara.org" o testi totalmente fuori contesto (copyright, crediti video), DEVI restituire una stringa vuota per quel segmento o rimuovere la frase.
4. Usa i nomi dei Personaggi forniti nel contesto per correggere eventuali storpiature.
5. Mantieni il tono colloquiale ma rendilo leggibile.
6. Se il testo contiene un chiaro cambio di interlocutore (es. il DM parla in prima persona come un NPC), inserisci il nome dell'NPC tra parentesi quadre all'inizio della frase. Esempio: "[Locandiere] Benvenuti!".

IMPORTANTE:
1. Non modificare "start" e "end".
2. Non unire o dividere segmenti. Il numero di oggetti in output deve essere identico all'input.
3. Restituisci un oggetto JSON con la chiave "segments", opzionalmente "detected_location", opzionalmente "atlas_update", opzionalmente "npc_updates" e opzionalmente "present_npcs".

Input:
${JSON.stringify(batchInput)}`;

        try {
            // MODIFICA IBRIDA: Usiamo localClient (Ollama) invece di openai
            const response = await withRetry(() => localClient.chat.completions.create({
                model: LOCAL_CORRECTION_MODEL,
                messages: [
                    { role: "system", content: "Sei un assistente che parla solo JSON valido." },
                    { role: "user", content: prompt }
                ],
                response_format: { type: "json_object" }
            }));

            const content = response.choices[0].message.content;
            if (!content) throw new Error("Empty");
            const parsed = JSON.parse(content);
            return parsed; // Ritorna l'oggetto completo { segments, detected_location?, atlas_update?, npc_updates?, present_npcs? }
        } catch (err) {
            console.error(`[Bardo] ⚠️ Errore batch ${idx+1} su Ollama, uso originale.`);
            return { segments: batch };
        }
    }, "Correzione Trascrizione (Ollama Local)");

    // Appiattiamo il risultato (array di oggetti -> array unico di segmenti e merge location)
    const allSegments = results.flatMap(r => r.segments || []);
    
    // Cerchiamo l'ultima location rilevata (se ce ne sono multiple, l'ultima vince)
    let lastDetectedLocation = undefined;
    let lastAtlasUpdate = undefined;
    const allNpcUpdates: any[] = [];
    const allPresentNpcs: Set<string> = new Set();

    for (const res of results) {
        if (res.detected_location) {
            lastDetectedLocation = res.detected_location;
        }
        if (res.atlas_update) {
            lastAtlasUpdate = res.atlas_update;
        }
        if (res.npc_updates && Array.isArray(res.npc_updates)) {
            allNpcUpdates.push(...res.npc_updates);
        }
        if (res.present_npcs && Array.isArray(res.present_npcs)) {
            res.present_npcs.forEach((n: string) => allPresentNpcs.add(n));
        }
    }

    return {
        segments: allSegments,
        detected_location: lastDetectedLocation,
        atlas_update: lastAtlasUpdate,
        npc_updates: allNpcUpdates,
        present_npcs: Array.from(allPresentNpcs)
    };
}

// --- FUNZIONE PRINCIPALE (RIASSUNTO) ---
export async function generateSummary(sessionId: string, tone: ToneKey = 'DM'): Promise<SummaryResponse> {
    console.log(`[Bardo] 📚 Generazione Riassunto per sessione ${sessionId} (Model: ${MODEL_NAME})...`);

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
        
        // Chiamiamo la funzione che ora restituisce l'oggetto strutturato
        const snapshot = getCampaignSnapshot(campaignId);
        
        // Estraiamo i dati per il RAG
        const activeCharNames = snapshot.characters.map((c: any) => c.character_name).filter(Boolean);
        const activeQuestTitles = snapshot.quests.map((q: any) => q.title);
        const locationQuery = snapshot.location ? `${snapshot.location.macro || ''} ${snapshot.location.micro || ''}`.trim() : "";

        const promises = [];
        
        // A. Ricerca Luogo
        if (locationQuery) {
            promises.push(searchKnowledge(campaignId, `Eventi passati a ${locationQuery}`, 3).then(res => ({ type: 'LUOGO', data: res })));
        }
        
        // B. Ricerca Personaggi
        if (activeCharNames.length > 0) {
            promises.push(searchKnowledge(campaignId, `Fatti su ${activeCharNames.join(', ')}`, 3).then(res => ({ type: 'PERSONAGGI', data: res })));
        }

        // C. Ricerca Quest
        if (activeQuestTitles.length > 0) {
            promises.push(searchKnowledge(campaignId, `Dettagli quest: ${activeQuestTitles.join(', ')}`, 3).then(res => ({ type: 'MISSIONI', data: res })));
        }

        const ragResults = await Promise.all(promises);

        // Costruiamo la stringa finale che andrà nel prompt
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
    // ----------------------------------------

    // Ricostruzione dialogo lineare
    const allFragments = [];
    for (const t of transcriptions) {
        try {
            const segments = JSON.parse(t.transcription_text);
            // NOTA: t.character_name è già il risultato di COALESCE(snapshot, current) dalla query SQL in db.ts
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

    // Aggiunta Note
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
        
        // Inserimento Marker di Scena
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

        // Usiamo processInBatches con barra di avanzamento
        const mapResults = await processInBatches(chunks, CONCURRENCY_LIMIT, async (chunk, index) => {
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
        // --- PROMPT IBRIDO (LOG + NARRATIVA) ---
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
  "loot": ["lista", "degli", "oggetti", "trovati"],
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

REGOLE IMPORTANTI PER 'character_growth':
- Estrai SOLO eventi che cambiano la vita o la personalità del personaggio.
- Tipi validi: 
  - 'BACKGROUND' (Rivelazioni sul passato, es. 'Incontra il padre perduto').
  - 'TRAUMA' (Eventi emotivi negativi forti, es. 'Uccide un innocente per sbaglio', 'Perde un braccio').
  - 'RELATIONSHIP' (Cambiamenti nelle relazioni chiave, es. 'Si innamora di X', 'Tradisce Y').
  - 'ACHIEVEMENT' (Grandi successi personali, non solo uccidere mostri).
  - 'GOAL_CHANGE' (Cambia obiettivo di vita).
- IGNORA: Danni in combattimento, acquisti, battute, interazioni minori. Vogliamo la "Storia", non la cronaca.

REGOLE PER 'npc_events':
- Registra eventi importanti che riguardano gli NPC (Non Giocanti).
- Tipi validi:
  - 'REVELATION' (Si scopre un segreto su di lui).
  - 'BETRAYAL' (Tradisce il party o qualcuno).
  - 'DEATH' (Muore).
  - 'ALLIANCE' (Si allea con il party).
  - 'STATUS_CHANGE' (Diventa Re, viene arrestato, cambia lavoro).
- Ignora semplici interazioni commerciali o chiacchiere.

REGOLE PER 'world_events':
- Estrai SOLO eventi che cambiano il mondo di gioco o la regione.
- Tipi validi:
  - 'WAR' (Inizio/Fine guerre, battaglie campali).
  - 'POLITICS' (Incoronazioni, leggi, alleanze tra nazioni).
  - 'DISCOVERY' (Scoperta di nuove terre, antiche rovine, artefatti leggendari).
  - 'CALAMITY' (Terremoti, piaghe, distruzioni di città).
  - 'SUPERNATURAL' (Intervento di divinità, rottura del velo magico).
- Non includere le azioni dei giocatori a meno che non abbiano conseguenze su scala regionale/globale.
`;

    } else {
        // --- PROMPT NARRATIVO (BARDO) ---
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
        5. LUNGHEZZA MASSIMA: Il riassunto NON DEVE superare i 6500 caratteri. Sii conciso ma evocativo.`;
    }

    try {
        const response = await withRetry(() => openai.chat.completions.create({
            model: MODEL_NAME, // USA IL MODELLO SMART
            messages: [
                { role: "system", content: reducePrompt },
                { role: "user", content: contextForFinalStep }
            ],
            response_format: { type: "json_object" }
        }));

        const content = response.choices[0].message.content || "{}";
        accumulatedTokens += response.usage?.total_tokens || 0;

        let parsed;
        try {
            // SANITIZZAZIONE: Rimuove i backtick del markdown se presenti (```json ... ```)
            const cleanContent = content.replace(/```json\n?|```/g, '').trim();
            parsed = JSON.parse(cleanContent);
        } catch (e) {
            console.error("[Bardo] ⚠️ Errore parsing JSON:", e);
            console.error("[Bardo] Content ricevuto:", content); // Utile per debug
            
            // Fallback: proviamo a salvare il contenuto come summary testuale
            parsed = { title: "Sessione Senza Titolo", summary: content, loot: [], loot_removed: [], quests: [] };
        }

        // MAPPING INTELLIGENTE PER RETROCOMPATIBILITÀ
        // Se il prompt ha generato "log" (nuovo formato DM), lo usiamo come "summary" (che è il campo principale visualizzato)
        // E "narrative" lo passiamo come campo extra.
        let finalSummary = parsed.summary;
        if (Array.isArray(parsed.log)) {
            finalSummary = parsed.log.join('\n');
        } else if (!finalSummary && parsed.narrative) {
            // Fallback se manca summary ma c'è narrative
            finalSummary = parsed.narrative;
        }

        return { 
            summary: finalSummary || "Errore generazione.", 
            title: parsed.title || "Sessione Senza Titolo",
            tokens: accumulatedTokens,
            loot: Array.isArray(parsed.loot) ? parsed.loot : [],
            loot_removed: Array.isArray(parsed.loot_removed) ? parsed.loot_removed : [],
            quests: Array.isArray(parsed.quests) ? parsed.quests : [],
            narrative: parsed.narrative, // NUOVO CAMPO
            log: Array.isArray(parsed.log) ? parsed.log : [], // NUOVO CAMPO
            character_growth: Array.isArray(parsed.character_growth) ? parsed.character_growth : [], // NUOVO CAMPO
            npc_events: Array.isArray(parsed.npc_events) ? parsed.npc_events : [], // NUOVO CAMPO
            world_events: Array.isArray(parsed.world_events) ? parsed.world_events : [] // NUOVO CAMPO
        };
    } catch (err: any) {
        console.error("Errore finale:", err);
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

    try {
        const response = await openai.chat.completions.create({
            model: MODEL_NAME, // Usa un modello intelligente per la scrittura
            messages: [{ role: "user", content: prompt }]
        });
        return response.choices[0].message.content || "Impossibile scrivere la biografia.";
    } catch (e) {
        console.error("Errore generazione bio:", e);
        return "Il biografo ha finito l'inchiostro.";
    }
}

// --- GENERATORE BIOGRAFIA NPC ---
export async function generateNpcBiography(campaignId: number, npcName: string, role: string, staticDesc: string): Promise<string> {
    const history = getNpcHistory(campaignId, npcName);

    // Combiniamo i dati statici (Dossier) con quelli storici (History)
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

    try {
        const response = await openai.chat.completions.create({
            model: MODEL_NAME,
            messages: [{ role: "user", content: prompt }]
        });
        return response.choices[0].message.content || "Impossibile scrivere il dossier.";
    } catch (e) {
        console.error("Errore generazione bio NPC:", e);
        return "Il dossier è bruciato.";
    }
}

// --- RAG: INGESTIONE BIOGRAFIA ---
export async function ingestBioEvent(campaignId: number, sessionId: string, charName: string, event: string, type: string) {
    const content = `[BIOGRAFIA: ${charName}] TIPO: ${type}. EVENTO: ${event}`;
    console.log(`[RAG] 🧠 Indicizzazione evento bio per ${charName}...`);

    // Determina provider e client (riutilizza la logica esistente in bard.ts)
    const provider = process.env.EMBEDDING_PROVIDER || process.env.AI_PROVIDER || 'openai';
    const isOllama = provider === 'ollama';
    const model = isOllama ? EMBEDDING_MODEL_OLLAMA : EMBEDDING_MODEL_OPENAI;
    const client = isOllama ? ollamaEmbedClient : openaiEmbedClient;

    try {
        const resp = await client.embeddings.create({ model: model, input: content });
        const vector = resp.data[0].embedding;

        // Inseriamo nel DB come frammento di conoscenza
        // Nota: Usiamo macro/micro null perché è un evento legato alla persona, non al luogo
        insertKnowledgeFragment(
            campaignId, 
            sessionId, 
            content, 
            vector, 
            model, 
            0, // timestamp fittizio
            null, // macro
            null, // micro
            [charName] // associamo esplicitamente l'NPC/PG
        );
    } catch (e) {
        console.error(`[RAG] ❌ Errore ingestione bio ${charName}:`, e);
    }
}

// --- RAG: INGESTIONE CRONACA MONDIALE ---
export async function ingestWorldEvent(campaignId: number, sessionId: string, event: string, type: string) {
    const content = `[STORIA DEL MONDO] TIPO: ${type}. EVENTO: ${event}`;
    console.log(`[RAG] 🌍 Indicizzazione evento globale...`);

    const provider = process.env.EMBEDDING_PROVIDER || process.env.AI_PROVIDER || 'openai';
    const isOllama = provider === 'ollama';
    const model = isOllama ? EMBEDDING_MODEL_OLLAMA : EMBEDDING_MODEL_OPENAI;
    const client = isOllama ? ollamaEmbedClient : openaiEmbedClient;

    try {
        const resp = await client.embeddings.create({ model: model, input: content });
        const vector = resp.data[0].embedding;

        // Inseriamo nel DB (macro/micro null perché è un evento storico generale)
        insertKnowledgeFragment(
            campaignId, 
            sessionId, 
            content, 
            vector, 
            model, 
            0, 
            null, 
            null, 
            ['MONDO', 'LORE', 'STORIA'] // Tag generici
        );
    } catch (e) {
        console.error(`[RAG] ❌ Errore ingestione mondo:`, e);
    }
}
