import { parentPort, workerData } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import OpenAI from 'openai';
import { getUserName, getUserProfile } from './db';

// CONFIGURAZIONE IBRIDA (OLLAMA / OPENAI)
const useOllama = process.env.AI_PROVIDER === 'ollama';

const openai = new OpenAI({
    // Se usiamo Ollama mettiamo l'URL locale, altrimenti undefined (usa default OpenAI)
    baseURL: useOllama ? 'http://ollama:11434/v1' : undefined,
    apiKey: useOllama ? 'ollama' : process.env.OPENAI_API_KEY, 
});

const { batchFolder } = workerData;

async function run() {
    // LOG DI AVVIO
    console.log("[Worker] 🚀 Avviato job di elaborazione batch...");

    const files = fs.readdirSync(batchFolder).filter(f => f.endsWith('.pcm'));
    
    if (files.length === 0) {
        console.log("[Worker] 💤 Nessun file da elaborare. Chiudo.");
        return;
    }

    console.log(`[Worker] 📂 Trovati ${files.length} file audio. Inizio analisi...`);

    // Set per tenere traccia degli ID unici dei parlanti in questa sessione
    const activeUserIds = new Set<string>();
    const transcriptions: Array<{ time: number, user: string, text: string }> = [];

    for (const file of files) {
        // file format: userId-timestamp.pcm
        const parts = file.replace('.pcm', '').split('-');
        if (parts.length < 2) continue;
        
        const userId = parts[0];
        const timestampStr = parts[1];
        const timestamp = parseInt(timestampStr);

        activeUserIds.add(userId); // <--- Salviamo l'ID

        const pcmPath = path.join(batchFolder, file);
        
        // --- FILTRO 1: Dimensione File ---
        // Ignoriamo file < 20KB (circa 0.1s di audio raw) per evitare file vuoti o header corrotti
        // PCM 48k 16bit stereo = ~192KB/sec
        const stats = fs.statSync(pcmPath);
        if (stats.size < 20000) {
            fs.unlinkSync(pcmPath);
            console.log(`[Worker] 🗑️ File troppo piccolo scartato: ${file}`);
            continue;
        }

        const wavPath = path.join(batchFolder, `${file}.wav`);
        
        try {
            await convertPcmToWav(pcmPath, wavPath);

            // 2. Trascrivi singolo frammento
            const result = await transcribeLocal(wavPath);
            
            // --- FILTRO 2: Lunghezza Testo ---
            // Modifica: Accettiamo tutto purché non sia vuoto (per non perdere "Sì", "No", "Ok")
            if (result && result.text && result.text.trim().length > 0) {
                // Recuperiamo solo il nome per il dialogo "script"
                const profile = getUserProfile(userId);
                const displayName = profile.character_name || `Utente ${userId}`;
                
                // LOG TRASCRIZIONE SUCCESSO
                console.log(`[Worker] ✅ Trascritto (${displayName}): "${result.text.substring(0, 30)}..."`);

                transcriptions.push({
                    time: timestamp,
                    user: displayName,
                    text: result.text.trim()
                });
            } else {
                // LOG TRASCRIZIONE VUOTA
                console.log(`[Worker] 🗑️ Audio scartato (silenzio o non valido): ${file}`);
            }
            
            // Pulizia
            if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
            if (fs.existsSync(pcmPath)) fs.unlinkSync(pcmPath);

        } catch (err) {
            console.error(`[Worker] ❌ ERRORE processamento ${file}:`, err);
        }
    }

    if (transcriptions.length === 0) {
        console.log("[Worker] ⚠️ Nessuna trascrizione valida prodotta. Skip.");
        parentPort?.postMessage({ status: 'skipped', message: 'Nessuna trascrizione valida (solo rumore?).' });
        return;
    }

    // 3. Riordina cronologicamente
    transcriptions.sort((a, b) => a.time - b.time);

    // --- COSTRUZIONE DEL CAST LIST ---
    let castContext = "PERSONAGGI E PROTAGONISTI:\n";
    activeUserIds.forEach(uid => {
        const p = getUserProfile(uid);
        if (p.character_name) {
            // Se è il DM
            if (p.character_name.toLowerCase().includes('dungeon master') || p.character_name.toLowerCase().includes('narratore')) {
                 castContext += `- ${p.character_name}: Il Narratore e Arbitro di gioco.\n`;
            } else {
                // Se è un PG
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
    // ---------------------------------

    // 4. Crea il testo strutturato per Ollama
    const fullDialogue = transcriptions
        .map(t => `[${t.user}]: ${t.text}`)
        .join("\n");

    // --- NUOVI LOG DI DEBUG ---
    console.log(`\n[Worker] 📜 --- INIZIO TESTO INVIATO ALL'AI ---`);
    console.log(fullDialogue);
    console.log(`[Worker] 📜 --- FINE TESTO INVIATO ALL'AI ---\n`);
    // --------------------------

    console.log(`[Worker] 📝 Dialogo ricostruito (${transcriptions.length} linee). Generazione riassunto in corso...`);
    
    // 5. RIASSUNTO LOCALE (Ollama)
    const summary = await generateSummary(fullDialogue, castContext);

    // --- NUOVO CONTROLLO ---
    if (summary.includes("SKIP_NESSUN_CONTENUTO")) {
        console.log("[Worker] 🔇 L'AI ha scartato il frammento (troppo breve o senza senso). Nessun messaggio inviato.");
        
        // Comunichiamo al main che abbiamo saltato, così non da errore
        parentPort?.postMessage({ status: 'skipped', message: 'AI: Contenuto non narrabile.' });
        return;
    }
    // -----------------------

    console.log("[Worker] ✨ Riassunto generato con successo! Invio al Main Thread.");

    parentPort?.postMessage({ 
        status: 'success', 
        summary: summary,
        originalText: fullDialogue 
    });
}

// --- FUNZIONI ---

function convertPcmToWav(input: string, output: string): Promise<void> {
    return new Promise((resolve, reject) => {
        // Usiamo "ffmpeg" direttamente perché installato nel Dockerfile con apt-get
        const ffmpegCommand = "ffmpeg";
        
        // PCM s16le 48k stereo (come da tuo voicerecorder.ts)
        const cmd = `${ffmpegCommand} -f s16le -ar 48000 -ac 2 -i "${input}" "${output}" -y`;
        exec(cmd, (err) => err ? reject(err) : resolve());
    });
}

// Nuova funzione per chiamare Python
function transcribeLocal(wavPath: string): Promise<{ text: string, error?: string }> {
    return new Promise((resolve, reject) => {
        // Chiamiamo lo script python creato prima
        const command = `python3 transcribe.py "${wavPath}"`;
        
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error("Python Error:", stderr);
                reject(error);
            } else {
                try {
                    const jsonResult = JSON.parse(stdout.trim());
                    resolve(jsonResult);
                } catch (e) {
                    // Fallback se non è JSON valido
                    resolve({ text: stdout.trim() });
                }
            }
        });
    });
}

async function generateSummary(dialogue: string, castInfo: string): Promise<string> {
    // Scegli il modello in base al provider
    const modelName = useOllama ? "llama3.2" : "gpt-4o"; // o "gpt-3.5-turbo" per risparmiare
    
    console.log(`[Worker] 🧠 Richiesta inviata a ${useOllama ? 'Ollama' : 'OpenAI'} (Modello: ${modelName})... attendere...`);

    try {
        const completion = await openai.chat.completions.create({
            model: modelName, 
            messages: [
                { 
                    role: "system", 
                    content: `Sei il Bardo Cronista di una campagna D&D.
                    
                    ${castInfo}
                    
                    ISTRUZIONI BASE:
                    - Usa le informazioni sui personaggi (razza, classe, carattere) per colorire la narrazione.
                    - Ignora regole, meta-gaming e frasi tecniche.
                    - Trasforma i dialoghi in narrazione epica in terza persona.
                    
                    ⚠️ ISTRUZIONE IMPORTANTE DI SICUREZZA ⚠️
                    Se il testo che ricevi è:
                    1. Troppo breve o frammentato per avere senso (es: parole a metà, frasi monche).
                    2. Solo rumore o imprecazioni senza contesto.
                    3. Completamente incomprensibile.
                    
                    ALLORA RISPONDI ESATTAMENTE E SOLO CON LA STRINGA: "SKIP_NESSUN_CONTENUTO".
                    Non aggiungere spiegazioni, scuse o altro. Solo quella stringa.
                    
                    IMPORTANTE: Rispondi rigorosamente in lingua ITALIANA.`
                },
                { 
                    role: "user", 
                    content: `Ecco il dialogo:\n\n${dialogue}` 
                }
            ],
        });
        return completion.choices[0].message.content || "Errore Generazione.";
    } catch (e) {
        console.error("Errore AI:", e);
        return "SKIP_NESSUN_CONTENUTO"; // Fallback in caso di errore
    }
}

run();
