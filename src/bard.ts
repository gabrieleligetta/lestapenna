import OpenAI from 'openai';
import {getSessionTranscript, getUserProfile} from './db';

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
    const transcriptions = getSessionTranscript(sessionId);

    if (transcriptions.length === 0) {
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

    // 3. AGGREGA IL TESTO
    // (Aggiungiamo un limite per non sforare i token se la sessione è di 8 ore)
    // TODO: Se diventa troppo lungo, bisognerà implementare una logica di chunking
    const fullDialogue = transcriptions
        .map(t => `[${t.character_name || 'Sconosciuto'}]: ${t.transcription_text}`)
        .join("\n");

    const systemPrompt = TONES[tone] || TONES.DM;

    console.log(`[Bardo] Genero riassunto per sessione ${sessionId} con tono ${tone}...`);

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
                    - Basati SOLO sul dialogo fornito.`
                },
                {role: "user", content: "Ecco la trascrizione della sessione:\n\n" + fullDialogue}
            ]
        });

        return response.choices[0].message.content || "Il Bardo è rimasto senza parole.";
    } catch (err: any) {
        console.error("Errore generazione riassunto:", err);
        return `Errore durante la narrazione: ${err.message}`;
    }
}
