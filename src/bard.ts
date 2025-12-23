import OpenAI from 'openai';
import {getSessionTranscript, getUserProfile, getSessionErrors, getSessionStartTime} from './db';

// --- CONFIGURAZIONE TONI (PRESET) ---
export const TONES = {
    EPICO: "Sei un cantastorie epico. Usa un linguaggio arcaico, solenne, enfatizza l'eroismo e il destino. Ignora i dettagli tecnici di gioco.",
    DIVERTENTE: "Sei un bardo ubriaco e sarcastico. Prendi in giro i fallimenti dei personaggi, usa un tono leggero e comico. Sottolinea le situazioni assurde.",
    OSCURO: "Sei un cronista di un mondo Lovecraftiano. Descrivi gli eventi con tono cupo, disperato e inquietante. Enfatizza la paura e l'ignoto.",
    CONCISO: "Sei un segretario efficiente. Fai un elenco puntato dei fatti accaduti. Nessun fronzolo narrativo. Solo fatti.",
    DM: "Sei un assistente per il Dungeon Master. Riassumi i punti salienti, i PNG incontrati, i mostri uccisi e i loot ottenuti. Utile per il recap della prossima sessione."
};

export type ToneKey = keyof typeof TONES;

const useOllama = process.env.AI_PROVIDER === 'ollama';
// Modello "veloce" per la fase MAP (estrazione fatti)
const FAST_MODEL = useOllama ? "llama3.2" : process.env.OPEN_AI_MODEL;
// Modello "smart" per la fase REDUCE (narrazione finale) - Usiamo lo stesso per ora, o gpt-4o se disponibile
const SMART_MODEL = useOllama ? "llama3.2" : process.env.OPEN_AI_MODEL;

const openai = new OpenAI({
    baseURL: useOllama ? 'http://ollama:11434/v1' : undefined,
    apiKey: useOllama ? 'ollama' : process.env.OPENAI_API_KEY,
});

/**
 * Divide il testo in chunk con sovrapposizione per mantenere il contesto.
 * @param text Testo completo
 * @param chunkSize Dimensione target del chunk (caratteri)
 * @param overlap Sovrapposizione tra chunk (caratteri)
 */
function splitTextInChunks(text: string, chunkSize: number = 15000, overlap: number = 1000): string[] {
    const chunks = [];
    let i = 0;
    while (i < text.length) {
        // Se siamo vicini alla fine, prendiamo tutto il resto
        if (i + chunkSize >= text.length) {
            chunks.push(text.substring(i));
            break;
        }

        let end = i + chunkSize;
        
        // Cerchiamo un punto di taglio naturale (a capo o spazio) per non troncare parole/frasi
        // Cerchiamo all'indietro partendo dal limite del chunk
        const lastNewLine = text.lastIndexOf('\n', end);
        const lastSpace = text.lastIndexOf(' ', end);
        
        // Preferiamo tagliare su un a capo se è abbastanza vicino (entro ultimi 10% del chunk)
        if (lastNewLine > i + (chunkSize * 0.9)) {
            end = lastNewLine;
        } else if (lastSpace > i + (chunkSize * 0.9)) {
            end = lastSpace;
        }

        chunks.push(text.substring(i, end));
        
        // Avanziamo, ma torniamo indietro di 'overlap' per mantenere il contesto
        // Assicuriamoci di non andare in loop se overlap >= chunkSize (impossibile con i default)
        i = end - overlap;
    }
    return chunks;
}

/**
 * FASE MAP: Estrae i fatti salienti da un chunk di testo.
 */
async function extractFactsFromChunk(chunk: string, index: number, total: number, castContext: string): Promise<string> {
    console.log(`[Bardo] 🗺️  Fase MAP: Analisi chunk ${index + 1}/${total} (${chunk.length} chars)...`);
    
    try {
        const response = await openai.chat.completions.create({
            model: process.env.OPEN_AI_MODEL!,
            messages: [
                {
                    role: "system",
                    content: `Sei un assistente analitico per sessioni di D&D.
                    Il tuo compito è leggere la trascrizione fornita ed estrarre SOLO i fatti rilevanti in un elenco puntato strutturato.
                    
                    ${castContext}

                    CATEGORIE RICHIESTE:
                    - ⚔️ Eventi/Combattimenti (chi contro chi, esito)
                    - 🗣️ Dialoghi Chiave (decisioni prese, rivelazioni)
                    - 👤 NPC Incontrati (nomi, ruoli, atteggiamento)
                    - 💎 Loot/Oggetti (cosa è stato trovato e chi lo ha preso)
                    
                    ISTRUZIONI:
                    - Sii conciso e oggettivo.
                    - Ignora chiacchiere off-topic, regole tecniche o battute fuori dal gioco.
                    - Usa i timestamp [MM:SS] se presenti per ordinare gli eventi.
                    - NON narrare, solo elenca.`
                },
                { role: "user", content: chunk }
            ]
        });
        return response.choices[0].message.content || "";
    } catch (err) {
        console.error(`[Bardo] ❌ Errore fase MAP chunk ${index + 1}:`, err);
        return ""; // Ritorniamo vuoto per non bloccare il processo
    }
}

export async function generateSummary(sessionId: string, tone: ToneKey = 'DM'): Promise<string> {
    // 1. RECUPERA I DATI DAL DB
    console.log(`[Bardo] 📚 Recupero trascrizioni per sessione ${sessionId}...`);
    const transcriptions = getSessionTranscript(sessionId);
    const errors = getSessionErrors(sessionId);
    const startTime = getSessionStartTime(sessionId) || 0;

    if (errors.length > 0) {
        console.warn(`[Bardo] Attenzione: ${errors.length} frammenti non sono stati trascritti a causa di errori.`);
    }

    if (transcriptions.length === 0) {
        if (errors.length > 0) {
            return `Purtroppo non è stato possibile recuperare la storia. Tutti i ${errors.length} frammenti audio hanno riscontrato errori durante la trascrizione.`;
        }
        return "Non ho trovato trascrizioni valide per questa sessione.";
    }

    // 2. COSTRUISCI IL CONTESTO DEI PERSONAGGI
    const userIds = new Set(transcriptions.map(t => t.user_id));
    let castContext = "PERSONAGGI E PROTAGONISTI:\n";

    userIds.forEach(uid => {
        const p = getUserProfile(uid);
        if (p.character_name) {
            if (p.character_name.toLowerCase().includes('dungeon master') || p.character_name.toLowerCase().includes('narratore') || p.character_name.toLowerCase().includes('DM')) {
                castContext += `- ${p.character_name}: Il Narratore e Arbitro di gioco.\n`;
            } else {
                let details = [];
                if (p.race) details.push(p.race);
                if (p.class) details.push(p.class);
                const info = details.length > 0 ? `(${details.join(' ')})` : '';
                castContext += `- ${p.character_name} ${info}`;
                if (p.description) castContext += `: ${p.description}`;
                castContext += "\n";
            }
        }
    });

    // 3. AGGREGA IL TESTO CON TIMESTAMP
    let fullDialogue = transcriptions
        .map(t => {
            const offsetMs = t.timestamp - startTime;
            const minutes = Math.floor(offsetMs / 60000);
            const seconds = Math.floor((offsetMs % 60000) / 1000);
            const timeStr = `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;
            return `${timeStr} [${t.character_name || 'Sconosciuto'}]: ${t.transcription_text}`;
        })
        .join("\n");

    // 4. STRATEGIA DI ELABORAZIONE
    const CHAR_LIMIT_FOR_MAP_REDUCE = 20000; // Soglia per attivare Map-Reduce
    let contextForFinalStep = "";
    let isMapReduce = false;

    if (fullDialogue.length > CHAR_LIMIT_FOR_MAP_REDUCE) {
        // --- STRATEGIA MAP-REDUCE ---
        console.log(`[Bardo] 🐘 Testo lungo rilevato (${fullDialogue.length} chars). Attivo strategia Map-Reduce.`);
        isMapReduce = true;

        const chunks = splitTextInChunks(fullDialogue);
        console.log(`[Bardo] 🔪 Testo diviso in ${chunks.length} segmenti.`);

        // Eseguiamo le chiamate MAP in parallelo (con limite di concorrenza implicito di Promise.all)
        // Se i chunk sono tanti, potremmo voler limitare la concorrenza, ma per ora va bene così.
        const mapResults = await Promise.all(chunks.map((chunk, index) => 
            extractFactsFromChunk(chunk, index, chunks.length, castContext)
        ));

        // Uniamo gli appunti
        contextForFinalStep = mapResults.join("\n\n--- SEGMENTO SUCCESSIVO ---\n\n");
        console.log(`[Bardo] 📉 Fase MAP completata. Contesto ridotto a ${contextForFinalStep.length} chars.`);

    } else {
        // --- STRATEGIA DIRETTA ---
        console.log(`[Bardo] 🐇 Testo breve (${fullDialogue.length} chars). Strategia diretta.`);
        contextForFinalStep = fullDialogue;
    }

    // 5. FASE REDUCE (O DIRETTA): Generazione Narrazione
    const systemPrompt = TONES[tone] || TONES.DM;
    const promptIntro = isMapReduce 
        ? "Ecco gli APPUNTI CRONOLOGICI estratti dalla sessione. Usali per ricostruire la narrazione completa." 
        : "Ecco la TRASCRIZIONE DIRETTA della sessione.";

    console.log(`[Bardo] ✍️  Fase REDUCE: Generazione racconto con tono ${tone}...`);

    try {
        const response = await openai.chat.completions.create({
            model: process.env.OPEN_AI_MODEL!,
            messages: [
                {
                    role: "system",
                    content: `${systemPrompt}
                    
                    ${castContext}
                    
                    ISTRUZIONI AGGIUNTIVE:
                    - Rispondi rigorosamente in lingua ITALIANA.
                    - ${isMapReduce ? "Usa gli appunti forniti per creare una narrazione fluida e coerente." : "Basati sulla trascrizione fornita."}
                    - Se ci sono buchi o incongruenze, mantieni la coerenza narrativa senza inventare fatti non presenti.
                    - Dai priorità alle descrizioni del Dungeon Master per stabilire i fatti oggettivi.`
                },
                { role: "user", content: `${promptIntro}\n\n${contextForFinalStep}` }
            ]
        });

        console.log(`[Bardo] ✅ Riassunto generato con successo per sessione ${sessionId}.`);
        return response.choices[0].message.content || "Il Bardo è rimasto senza parole.";
    } catch (err: any) {
        console.error("Errore generazione riassunto:", err);
        return `Errore durante la narrazione: ${err.message}`;
    }
}
