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

const openai = new OpenAI({
    baseURL: useOllama ? 'http://ollama:11434/v1' : undefined,
    apiKey: useOllama ? 'ollama' : process.env.OPENAI_API_KEY,
});

export async function generateSummary(sessionId: string, tone: ToneKey = 'DM'): Promise<string> {
    // 1. RECUPERA I DATI DAL DB (Nessuna trascrizione necessaria!)
    console.log(`[Bardo] 📚 Recupero trascrizioni per sessione ${sessionId}...`);
    const transcriptions = getSessionTranscript(sessionId);
    const errors = getSessionErrors(sessionId);
    const startTime = getSessionStartTime(sessionId) || 0;

    if (errors.length > 0) {
        console.warn(`[Bardo] Attenzione: ${errors.length} frammenti non sono stati trascritti a causa di errori.`);
    }

    if (transcriptions.length === 0) {
        if (errors.length > 0) {
            return `Purtroppo non è stato possibile recuperare la storia. Tutti i ${errors.length} frammenti audio hanno riscontrato errori durante la trascrizione (lo Scriba ha avuto problemi tecnici).`;
        }
        return "Non ho trovato trascrizioni valide per questa sessione. Forse lo Scriba sta ancora lavorando o la sessione era vuota?";
    }

    // 2. COSTRUISCI IL CONTESTO DEI PERSONAGGI
    // (Utile per dare colore alla narrazione)
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

    // 3. AGGREGA IL TESTO CON TIMESTAMP RELATIVI
    // Gestione della lunghezza per evitare di superare i limiti di token
    const MAX_CHARS = 400000; // Circa 100k token
    
    let fullDialogue = transcriptions
        .map(t => {
            // Calcola offset temporale in formato MM:SS
            const offsetMs = t.timestamp - startTime;
            const minutes = Math.floor(offsetMs / 60000);
            const seconds = Math.floor((offsetMs % 60000) / 1000);
            const timeStr = `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;
            
            return `${timeStr} [${t.character_name || 'Sconosciuto'}]: ${t.transcription_text}`;
        })
        .join("\n");

    // CHUNKING INTELLIGENTE (Semplificato)
    // Se superiamo il limite, invece di troncare alla fine, cerchiamo di mantenere l'inizio e la fine,
    // sacrificando la parte centrale se necessario, o semplicemente troncando se è l'unica opzione.
    if (fullDialogue.length > MAX_CHARS) {
        console.warn(`[Bardo] Sessione estremamente lunga (${fullDialogue.length} caratteri). Applico chunking.`);
        // Strategia semplice: prendiamo i primi 60% e gli ultimi 40% del limite disponibile
        const limitHead = Math.floor(MAX_CHARS * 0.6);
        const limitTail = Math.floor(MAX_CHARS * 0.4);
        
        const head = fullDialogue.substring(0, limitHead);
        const tail = fullDialogue.substring(fullDialogue.length - limitTail);
        
        fullDialogue = `${head}\n\n... [PARTE CENTRALE OMESSA PER LIMITI DI MEMORIA] ...\n\n${tail}`;
    }

    const systemPrompt = TONES[tone] || TONES.DM;

    console.log(`[Bardo] Genero riassunto per sessione ${sessionId} con tono ${tone} (${fullDialogue.length} caratteri)...`);

    // 4. CHIAMATA LLM
    try {
        const response = await openai.chat.completions.create({
            model: useOllama ? "llama3.2" : "gpt-5-mini",
            messages: [
                {
                    role: "system",
                    content: `${systemPrompt}
                    
                    ${castContext}
                    
                    ISTRUZIONI AGGIUNTIVE:
                    - Rispondi rigorosamente in lingua ITALIANA.
                    - Basati esclusivamente sulla trascrizione fornita.
                    - I timestamp [MM:SS] indicano quando è stata pronunciata la frase. Usali per ricostruire la sequenza temporale corretta, specialmente se ci sono sovrapposizioni.
                    - Se più personaggi parlano contemporaneamente o si interrompono, cerca di ricostruire il filo logico della discussione principale.
                    - Dai priorità alle descrizioni del Dungeon Master (DM/Narratore) per stabilire i fatti oggettivi.
                    - Se ci sono buchi o incongruenze, mantieni la coerenza narrativa senza inventare fatti non presenti.`
                },
                {role: "user", content: "Ecco la trascrizione della sessione:\n\n" + fullDialogue}
            ]
        });

        console.log(`[Bardo] ✅ Riassunto generato con successo per sessione ${sessionId}.`);
        return response.choices[0].message.content || "Il Bardo è rimasto senza parole.";
    } catch (err: any) {
        console.error("Errore generazione riassunto:", err);
        return `Errore durante la narrazione: ${err.message}`;
    }
}
