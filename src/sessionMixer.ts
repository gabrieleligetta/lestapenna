import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getSessionRecordings, getSessionStartTime } from './db';
import { downloadFromOracle } from './backupService';

const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');
const OUTPUT_DIR = path.join(__dirname, '..', 'mixed_sessions');
const TEMP_DIR = path.join(__dirname, '..', 'temp_mix');

// Configurazione
const BATCH_SIZE = 50; // Numero di file da processare per volta (basso per sicurezza)

// Assicuriamoci che le cartelle esistano
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

export async function mixSessionAudio(sessionId: string): Promise<string> {
    console.log(`[Mixer] 🧱 Inizio mixaggio ITERATIVO sessione ${sessionId}...`);

    const recordings = getSessionRecordings(sessionId);
    const sessionStart = getSessionStartTime(sessionId);

    if (!recordings.length || !sessionStart) {
        throw new Error("Nessuna registrazione trovata.");
    }

    // 1. Download e Preparazione Lista
    console.log(`[Mixer] 📥 Verifica/Download di ${recordings.length} file...`);
    
    const validFiles: { path: string, delay: number }[] = [];

    for (const rec of recordings) {
        const filePath = path.join(RECORDINGS_DIR, rec.filename);
        if (!fs.existsSync(filePath)) {
            const success = await downloadFromOracle(rec.filename, filePath, sessionId);
            if (!success) continue;
        }
        validFiles.push({ 
            path: filePath, 
            delay: rec.timestamp - sessionStart 
        });
    }

    if (validFiles.length === 0) throw new Error("Nessun file valido.");

    // Calcolo statistiche iniziali
    const totalInputBytes = validFiles.reduce((sum, f) => {
        try { return sum + fs.statSync(f.path).size; } catch (e) { return sum; }
    }, 0);
    const totalInputMB = (totalInputBytes / (1024 * 1024)).toFixed(2);
    console.log(`[Mixer] 📊 Info Input: ${validFiles.length} file validi. Dimensione totale sorgenti: ${totalInputMB} MB`);

    // File "Accumulatore" temporaneo (FLAC per non perdere qualità e superare limite 4GB WAV)
    let accumulatorPath = path.join(TEMP_DIR, `acc_${sessionId}.flac`);
    // File temporaneo per il passaggio corrente
    const stepOutputPath = path.join(TEMP_DIR, `step_${sessionId}.flac`);

    // Pulizia preventiva
    if (fs.existsSync(accumulatorPath)) fs.unlinkSync(accumulatorPath);

    // 2. Loop a Blocchi (The Accumulator Loop)
    let processedCount = 0;
    const startTime = Date.now();
    
    while (processedCount < validFiles.length) {
        const batch = validFiles.slice(processedCount, processedCount + BATCH_SIZE);
        const isFirstBatch = processedCount === 0;
        const batchStart = Date.now();
        
        console.log(`[Mixer] 🔄 Elaborazione blocco ${processedCount + 1} - ${processedCount + batch.length} di ${validFiles.length}...`);

        await processBatch(batch, accumulatorPath, stepOutputPath, isFirstBatch);

        // Se non è il primo batch, il risultato del passo (stepOutput) diventa il nuovo accumulatore
        if (!isFirstBatch) {
            fs.renameSync(stepOutputPath, accumulatorPath);
        }
        
        // Statistiche intermedie
        const batchDuration = ((Date.now() - batchStart) / 1000).toFixed(1);
        let accSizeMB = "0.00";
        try {
            accSizeMB = (fs.statSync(accumulatorPath).size / (1024 * 1024)).toFixed(2);
        } catch (e) {}
        
        const memUsage = process.memoryUsage();
        const rssMB = (memUsage.rss / 1024 / 1024).toFixed(0);
        
        console.log(`[Mixer] 📈 Stats: Batch in ${batchDuration}s | Temp File: ${accSizeMB} MB | RAM: ${rssMB} MB`);
        
        processedCount += batch.length;
        
        // Garbage Collection forzata (opzionale, Node lo fa da solo ma su grandi loop aiuta)
        if (global.gc) global.gc(); 
    }

    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Mixer] ⏱️  Mixaggio completato in ${totalDuration}s.`);

    // 3. Conversione Finale in MP3
    console.log(`[Mixer] 🎛️  Conversione finale FLAC -> MP3...`);
    const finalMp3Path = path.join(OUTPUT_DIR, `session_${sessionId}_full.mp3`);
    
    await convertToMp3(accumulatorPath, finalMp3Path);

    // 4. Pulizia File Temporanei
    try {
        if (fs.existsSync(accumulatorPath)) fs.unlinkSync(accumulatorPath);
        if (fs.existsSync(stepOutputPath)) fs.unlinkSync(stepOutputPath);
    } catch (e) {
        console.warn("[Mixer] Warning pulizia temp:", e);
    }

    console.log(`[Mixer] ✅ Mix completato: ${finalMp3Path}`);
    return finalMp3Path;
}

/**
 * Esegue il mix di un batch di file sopra l'accumulatore esistente
 */
function processBatch(
    files: { path: string, delay: number }[], 
    accumulatorPath: string, 
    outputPath: string, 
    isFirstBatch: boolean
): Promise<void> {
    return new Promise((resolve, reject) => {
        const args: string[] = [];
        let filterComplex = "";
        let inputCount = 0;

        // Se NON è il primo batch, il primo input è l'accumulatore esistente
        if (!isFirstBatch) {
            args.push('-i', accumulatorPath);
            // L'accumulatore parte sempre da 0 (delay 0)
            // [0] è l'accumulatore
            inputCount++; 
        }

        // Aggiungiamo i file del batch corrente
        files.forEach((f) => {
            args.push('-i', f.path);
        });

        // Costruzione Filter Complex
        const outputTags: string[] = [];
        
        // Se c'è l'accumulatore, lo passiamo diretto al mix (non ha bisogno di adelay)
        if (!isFirstBatch) {
            outputTags.push('[0]'); 
        }

        files.forEach((f, idx) => {
            // L'indice reale dell'input dipende se c'è l'accumulatore prima
            const realInputIndex = isFirstBatch ? idx : idx + 1;
            const tag = `s${idx}`;
            
            // Applichiamo il delay
            filterComplex += `[${realInputIndex}]adelay=${f.delay}|${f.delay}[${tag}];`;
            outputTags.push(`[${tag}]`);
        });

        // Mix finale
        // normalize=0 è CRUCIALE: impedisce a ffmpeg di abbassare il volume 
        // proporzionalmente al numero di input, evitando che l'audio sparisca dopo 10 iterazioni.
        // dropout_transition=0: stacco netto quando finisce un file
        const totalInputs = outputTags.length;
        filterComplex += `${outputTags.join('')}amix=inputs=${totalInputs}:dropout_transition=0:normalize=0[out]`;

        const destination = isFirstBatch ? accumulatorPath : outputPath;

        const ffmpegArgs = [
            ...args,
            '-filter_complex', filterComplex,
            '-map', '[out]',
            '-ac', '2',     // Stereo
            '-c:a', 'flac', // FLAC (Lossless) per i passaggi intermedi, supporta >4GB
            destination,
            '-y'
        ];

        // console.log("Spawn FFmpeg:", ffmpegArgs.join(" "));

        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        let stderr = "";

        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) resolve();
            else {
                console.error(`[Mixer] FFmpeg Error Log:\n${stderr.slice(-1000)}`); // Ultimi 1000 caratteri
                reject(new Error(`FFmpeg step failed with code ${code}`));
            }
        });

        ffmpeg.on('error', (err) => reject(err));
    });
}

/**
 * Converte il FLAC master finale in MP3 compresso
 */
function convertToMp3(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-i', inputPath,
            '-codec:a', 'libmp3lame',
            '-b:a', '128k', // Bitrate MP3 finale
            outputPath,
            '-y'
        ]);

        let stderr = "";
        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) resolve();
            else {
                console.error(`[Mixer] MP3 Conversion Error Log:\n${stderr.slice(-1000)}`);
                reject(new Error(`MP3 conversion failed code ${code}`));
            }
        });
        
        ffmpeg.on('error', reject);
    });
}
