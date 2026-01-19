import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getSessionRecordings, getSessionStartTime } from './db';
import { downloadFromOracle, uploadToOracle, deleteFromOracle } from './backupService';

const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');
const OUTPUT_DIR = path.join(__dirname, '..', 'mixed_sessions');
const TEMP_DIR = path.join(__dirname, '..', 'temp_mix');

// Configurazione
const BATCH_SIZE = 50; // Numero di file da processare per volta (basso per sicurezza)

// Assicuriamoci che le cartelle esistano
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

export async function mixSessionAudio(sessionId: string): Promise<string> {
    console.log(`[Mixer] 🧱 Inizio mixaggio ALLINEATO sessione ${sessionId}...`);

    const recordings = getSessionRecordings(sessionId);
    // NON usiamo più getSessionStartTime dal DB come riferimento assoluto
    // const sessionStart = getSessionStartTime(sessionId); 

    if (!recordings.length) {
        throw new Error("Nessuna registrazione trovata.");
    }

    // 1. Download, Validazione e Calcolo "Tempo Zero"
    console.log(`[Mixer] 📥 Verifica/Download di ${recordings.length} file...`);
    
    const validFiles: { path: string, timestamp: number }[] = [];
    const timestamps: number[] = [];

    for (const rec of recordings) {
        const filePath = path.join(RECORDINGS_DIR, rec.filename);
        
        // Download se manca
        if (!fs.existsSync(filePath)) {
            const success = await downloadFromOracle(rec.filename, filePath, sessionId);
            if (!success) continue;
        }

        // Check integrità (Fix per crash precedente)
        try {
            const stats = fs.statSync(filePath);
            if (stats.size < 1024) { 
                // console.warn(`[Mixer] ⚠️ Ignorato file vuoto/corrotto: ${rec.filename}`);
                continue;
            }
        } catch (e) { continue; }

        validFiles.push({ 
            path: filePath, 
            timestamp: rec.timestamp 
        });
        timestamps.push(rec.timestamp);
    }

    if (validFiles.length === 0) throw new Error("Nessun file valido per il mix.");

    // CALCOLO TEMPO ZERO REALE (Il momento in cui il primo utente ha parlato)
    // Questo allinea tutti i file relativamente al primo evento audio, ignorando latenze del comando /start
    const realSessionStart = Math.min(...timestamps);
    
    // Preparazione lista finale con delay calcolato
    const filesToProcess = validFiles.map(f => ({
        path: f.path,
        delay: Math.max(0, f.timestamp - realSessionStart) // Delay relativo al primo audio
    })).sort((a, b) => a.delay - b.delay); // Importante: ordinare cronologicamente

    console.log(`[Mixer] 📊 Info Input: ${filesToProcess.length} file validi. Start Time (Epoch): ${realSessionStart}`);

    let accumulatorPath = path.join(TEMP_DIR, `acc_${sessionId}.flac`);
    const stepOutputPath = path.join(TEMP_DIR, `step_${sessionId}.flac`);

    if (fs.existsSync(accumulatorPath)) fs.unlinkSync(accumulatorPath);

    // 2. Loop a Blocchi
    let processedCount = 0;
    const startTime = Date.now();
    
    while (processedCount < filesToProcess.length) {
        const batch = filesToProcess.slice(processedCount, processedCount + BATCH_SIZE);
        const isFirstBatch = processedCount === 0;
        
        console.log(`[Mixer] 🔄 Elaborazione blocco ${processedCount + 1} - ${processedCount + batch.length} di ${filesToProcess.length}...`);

        await processBatch(batch, accumulatorPath, stepOutputPath, isFirstBatch);

        if (!isFirstBatch) {
            fs.renameSync(stepOutputPath, accumulatorPath);
        }
        
        processedCount += batch.length;
        if (global.gc) global.gc(); 
    }

    // 3. Conversione Finale
    console.log(`[Mixer] 🎛️  Conversione finale FLAC -> MP3...`);
    const finalMp3Path = path.join(OUTPUT_DIR, `session_${sessionId}_full.mp3`);
    
    await convertToMp3(accumulatorPath, finalMp3Path);

    // 4. Upload su Oracle (Sovrascrittura ESPLICITA: Delete + Upload)
    const finalFileName = path.basename(finalMp3Path);
    const targetKey = `recordings/${sessionId}/${finalFileName}`;
    
    console.log(`[Mixer] 🗑️ Rimozione vecchia versione Cloud (se presente): ${targetKey}`);
    await deleteFromOracle(finalFileName, sessionId);

    console.log(`[Mixer] ☁️ Upload nuova versione su Oracle: ${targetKey}`);
    await uploadToOracle(finalMp3Path, finalFileName, sessionId, targetKey);

    // Pulizia
    try {
        if (fs.existsSync(accumulatorPath)) fs.unlinkSync(accumulatorPath);
        if (fs.existsSync(stepOutputPath)) fs.unlinkSync(stepOutputPath);
    } catch (e) {}

    console.log(`[Mixer] ✅ Mix completato e allineato: ${finalMp3Path}`);
    return finalMp3Path;
}

function processBatch(
    files: { path: string, delay: number }[], 
    accumulatorPath: string, 
    outputPath: string, 
    isFirstBatch: boolean
): Promise<void> {
    return new Promise((resolve, reject) => {
        const args: string[] = [];
        let filterComplex = "";
        
        // Input 0: Accumulatore (se esiste)
        if (!isFirstBatch) {
            args.push('-i', accumulatorPath);
        }

        // Altri Input
        files.forEach((f) => {
            args.push('-i', f.path);
        });

        // Costruzione Filter Complex
        const outputTags: string[] = [];
        
        if (!isFirstBatch) {
            // L'accumulatore è già a 48kHz e mixato, lo passiamo diretto
            outputTags.push('[0]'); 
        }

        files.forEach((f, idx) => {
            const realInputIndex = isFirstBatch ? idx : idx + 1;
            const tag = `s${idx}`;
            
            // FILTRO CRUCIALE PER L'ALLINEAMENTO:
            // 1. aresample=48000:async=1 -> Porta tutto a 48kHz e corregge timestamp (async) per evitare drift
            // 2. adelay -> Posiziona l'audio nel tempo corretto
            filterComplex += `[${realInputIndex}]aresample=48000:async=1,adelay=${f.delay}|${f.delay}[${tag}];`;
            outputTags.push(`[${tag}]`);
        });

        const totalInputs = outputTags.length;
        // amix con normalize=0 per non perdere volume man mano che si aggiungono file
        filterComplex += `${outputTags.join('')}amix=inputs=${totalInputs}:dropout_transition=0:normalize=0[out]`;

        const destination = isFirstBatch ? accumulatorPath : outputPath;

        const ffmpegArgs = [
            ...args,
            '-filter_complex', filterComplex,
            '-map', '[out]',
            '-ac', '2',       // Stereo
            '-ar', '48000',   // FORZA 48kHz in output (standard Discord/Video)
            '-c:a', 'flac',   // Lossless intermedio
            destination,
            '-y'
        ];

        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        let stderr = "";

        ffmpeg.stderr.on('data', d => stderr += d.toString());
        ffmpeg.on('close', (code) => {
            if (code === 0) resolve();
            else {
                console.error(`[Mixer] FFmpeg Error:\n${stderr.slice(-1000)}`);
                reject(new Error(`FFmpeg code ${code}`));
            }
        });
        ffmpeg.on('error', reject);
    });
}

function convertToMp3(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-i', inputPath,
            '-codec:a', 'libmp3lame',
            '-b:a', '192k', // Alziamo un po' la qualità finale
            '-ac', '2',
            '-ar', '48000', // Manteniamo 48kHz anche nell'MP3 finale
            outputPath,
            '-y'
        ]);

        let stderr = "";
        ffmpeg.stderr.on('data', d => stderr += d.toString());
        ffmpeg.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`MP3 conv failed code ${code}`));
        });
        ffmpeg.on('error', reject);
    });
}
