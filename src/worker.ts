import { parentPort, workerData } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import OpenAI from 'openai';

// CONFIGURAZIONE OLLAMA (DOCKER NETWORK)
const openai = new OpenAI({
    baseURL: 'http://ollama:11434/v1',
    apiKey: 'ollama', // Placeholder richiesto
});

const { batchFolder } = workerData;

// Mappa fittizia (da caricare da DB/JSON in futuro)
const characterMap: Record<string, string> = {};

// Carica la mappa dei personaggi se esiste
const mapPath = path.join(__dirname, '..', 'character_map.json');
if (fs.existsSync(mapPath)) {
    try {
        const data = fs.readFileSync(mapPath, 'utf8');
        Object.assign(characterMap, JSON.parse(data));
    } catch (e) {
        console.error("[Worker] Errore caricamento character_map.json", e);
    }
}

async function run() {
    const files = fs.readdirSync(batchFolder).filter(f => f.endsWith('.pcm'));
    
    if (files.length === 0) return;

    console.log(`[Worker] 🎛️ Trovati ${files.length} frammenti. Elaborazione singola...`);

    const transcriptions: Array<{ time: number, user: string, text: string }> = [];

    for (const file of files) {
        // file format: userId-timestamp.pcm
        const parts = file.replace('.pcm', '').split('-');
        if (parts.length < 2) continue;
        
        const userId = parts[0];
        const timestampStr = parts[1];
        const timestamp = parseInt(timestampStr);

        const pcmPath = path.join(batchFolder, file);
        
        // --- FILTRO 1: Dimensione File ---
        // Ignoriamo file < 20KB (circa 0.1s di audio raw) per evitare file vuoti o header corrotti
        // PCM 48k 16bit stereo = ~192KB/sec
        const stats = fs.statSync(pcmPath);
        if (stats.size < 20000) {
            fs.unlinkSync(pcmPath);
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
                transcriptions.push({
                    time: timestamp,
                    user: characterMap[userId] || `Utente ${userId}`, // Usa il nome PG se c'è
                    text: result.text.trim()
                });
            }
            
            // Pulizia
            if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
            if (fs.existsSync(pcmPath)) fs.unlinkSync(pcmPath);

        } catch (err) {
            console.error(`[Worker] Errore processamento file ${file}:`, err);
        }
    }

    if (transcriptions.length === 0) {
        parentPort?.postMessage({ status: 'skipped', message: 'Nessuna trascrizione valida (solo rumore?).' });
        return;
    }

    // 3. Riordina cronologicamente
    transcriptions.sort((a, b) => a.time - b.time);

    // 4. Crea il testo strutturato per Ollama
    const fullDialogue = transcriptions
        .map(t => `[${t.user}]: ${t.text}`)
        .join("\n");

    console.log(`[Worker] 📝 Dialogo ricostruito:\n${fullDialogue.substring(0, 200)}...`);
    console.log(`[Worker] 🧙‍♂️ Chiedo il riassunto a Ollama (Llama 3.2)...`);

    // 5. RIASSUNTO LOCALE (Ollama)
    const summary = await generateSummary(fullDialogue);

    parentPort?.postMessage({ 
        status: 'success', 
        summary: summary,
        originalText: fullDialogue 
    });
}

// --- FUNZIONI ---

function convertPcmToWav(input: string, output: string): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!ffmpegPath) return reject("FFmpeg non trovato");
        // PCM s16le 48k stereo (come da tuo voicerecorder.ts)
        const cmd = `"${ffmpegPath}" -f s16le -ar 48000 -ac 2 -i "${input}" "${output}" -y`;
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

async function generateSummary(text: string): Promise<string> {
    try {
        const completion = await openai.chat.completions.create({
            model: "llama3.2", // Il nome del modello che hai scaricato su Ollama
            messages: [
                { 
                    role: "system", 
                    content: `Sei il Bardo Cronista di D&D. Riassumi questa sessione in italiano.
                    Stile: Epico, Conciso, Bullet Points. Ignora il meta-game.`
                },
                { 
                    role: "user", 
                    content: `Ecco la trascrizione del dialogo tra i personaggi. I nomi tra parentesi quadre indicano chi parla.\n\n${text}` 
                }
            ],
        });
        return completion.choices[0].message.content || "Errore Ollama.";
    } catch (e) {
        console.error("Errore Ollama:", e);
        return "Impossibile contattare il Bardo (Ollama offline?).";
    }
}

run();
