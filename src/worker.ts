import { parentPort, workerData } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import OpenAI from 'openai';
import { getUserName } from './db';

// CONFIGURAZIONE IBRIDA (OLLAMA / OPENAI)
const useOllama = process.env.AI_PROVIDER === 'ollama';

const openai = new OpenAI({
    // Se usiamo Ollama mettiamo l'URL locale, altrimenti undefined (usa default OpenAI)
    baseURL: useOllama ? 'http://ollama:11434/v1' : undefined,
    apiKey: useOllama ? 'ollama' : process.env.OPENAI_API_KEY, 
});

const { batchFolder } = workerData;

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
                // Recuperiamo il nome dal DB
                const characterName = getUserName(userId);
                
                transcriptions.push({
                    time: timestamp,
                    user: characterName || `Utente ${userId}`, // Usa il nome PG se c'è
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
    console.log(`[Worker] 🧙‍♂️ Chiedo il riassunto a ${useOllama ? 'Ollama' : 'OpenAI'}...`);

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
    // Scegli il modello in base al provider
    const modelName = useOllama ? "llama3.2" : "gpt-4o"; // o "gpt-3.5-turbo" per risparmiare

    try {
        const completion = await openai.chat.completions.create({
            model: modelName, 
            messages: [
                { 
                    role: "system", 
                    content: `Sei il Bardo Cronista di una campagna D&D. 
                    Riceverai un copione di dialogo nel formato "**Nome**: Frase".
                    Riassumi gli eventi accaduti in stile narrativo epico. 
                    Usa i nomi dei personaggi forniti. Ignora commenti tecnici o fuori dal gioco.`
                },
                { 
                    role: "user", 
                    content: `Ecco la trascrizione del dialogo tra i personaggi. I nomi tra parentesi quadre indicano chi parla.\n\n${text}` 
                }
            ],
        });
        return completion.choices[0].message.content || "Errore Generazione.";
    } catch (e) {
        console.error("Errore AI:", e);
        return "Il Bardo non risponde.";
    }
}

run();
