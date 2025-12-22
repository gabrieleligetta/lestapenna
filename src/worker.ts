import { parentPort, workerData } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import OpenAI from 'openai';

// CONFIGURAZIONE OLLAMA (DOCKER NETWORK)
// 'http://ollama:11434/v1' -> 'ollama' è il nome del servizio nel docker-compose
const openai = new OpenAI({
    baseURL: 'http://ollama:11434/v1',
    apiKey: 'ollama', // Placeholder richiesto
});

const { batchFolder } = workerData;

async function run() {
    const files = fs.readdirSync(batchFolder).filter(f => f.endsWith('.pcm'));
    
    if (files.length === 0) return;

    console.log(`[Worker] 🎛️ Trovati ${files.length} frammenti. Mixaggio...`);

    const mixedWavPath = path.join(batchFolder, `mixed_session_${Date.now()}.wav`);
    
    try {
        // 1. MIXAGGIO (Resta uguale, è perfetto)
        await mixAudioFiles(files, batchFolder, mixedWavPath);
        
        // 2. TRASCRIZIONE LOCALE (Python + Faster Whisper)
        console.log("[Worker] 🧠 Avvio Whisper Locale (Python)...");
        const transcript = await transcribeLocal(mixedWavPath);

        // Pulizia
        if (fs.existsSync(mixedWavPath)) fs.unlinkSync(mixedWavPath);

        if (!transcript || transcript.trim().length === 0) {
            parentPort?.postMessage({ status: 'skipped', message: 'Audio vuoto.' });
            return;
        }

        console.log(`[Worker] 📝 Testo: ${transcript.substring(0, 50)}...`);
        console.log(`[Worker] 🧙‍♂️ Chiedo il riassunto a Ollama (Llama 3.2)...`);

        // 3. RIASSUNTO LOCALE (Ollama)
        const summary = await generateSummary(transcript);

        parentPort?.postMessage({ 
            status: 'success', 
            summary: summary,
            originalText: transcript 
        });

    } catch (err) {
        console.error(`[Worker] ❌ Errore:`, err);
    }
}

// --- FUNZIONI ---

function mixAudioFiles(files: string[], folder: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!ffmpegPath) return reject("FFmpeg non trovato");
        
        const audioData = files.map(file => {
            const parts = file.split('-');
            const timestamp = parseInt(parts[1].replace('.pcm', ''));
            return { path: path.join(folder, file), startTime: timestamp };
        });
        audioData.sort((a, b) => a.startTime - b.startTime);
        const sessionStart = audioData[0].startTime;

        let inputs = "";
        let filterParts = "";
        let mixInputs = "";

        audioData.forEach((audio, index) => {
            inputs += ` -f s16le -ar 48000 -ac 2 -i "${audio.path}"`;
            const delay = audio.startTime - sessionStart;
            filterParts += `[${index}]adelay=${delay}|${delay}[d${index}];`;
            mixInputs += `[d${index}]`;
        });

        const complexFilter = `${filterParts}${mixInputs}amix=inputs=${audioData.length}:duration=longest[out]`;
        const command = `"${ffmpegPath}" ${inputs} -filter_complex "${complexFilter}" -map "[out]" "${outputPath}" -y`;

        exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error) => {
            if (error) reject(error);
            else {
                audioData.forEach(a => { try { fs.unlinkSync(a.path); } catch(e) {} });
                resolve();
            }
        });
    });
}

// Nuova funzione per chiamare Python
function transcribeLocal(wavPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        // Chiamiamo lo script python creato prima
        const command = `python3 transcribe.py "${wavPath}"`;
        
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error("Python Error:", stderr);
                reject(error);
            } else {
                resolve(stdout.trim());
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
                { role: "user", content: text }
            ],
        });
        return completion.choices[0].message.content || "Errore Ollama.";
    } catch (e) {
        console.error("Errore Ollama:", e);
        return "Impossibile contattare il Bardo (Ollama offline?).";
    }
}

run();
