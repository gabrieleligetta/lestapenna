import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getSessionRecordings, getSessionStartTime } from './db';
import { downloadFromOracle } from './backupService';

const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');
const OUTPUT_DIR = path.join(__dirname, '..', 'mixed_sessions');
const TEMP_DIR = path.join(__dirname, '..', 'temp_mix');

// Configurazione
const BATCH_SIZE = 10; // Ridotto per gestire file f32le più pesanti
// Bitrate Master: 192k è un ottimo compromesso per podcast stereo
const MASTER_BITRATE = '192k';

// Assicuriamoci che le cartelle esistano
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

/**
 * Mixaggio Audio "Audiophile Safe"
 * Usa un accumulatore a 32-bit Float per evitare il clipping durante la somma delle tracce.
 */
export async function mixSessionAudio(sessionId: string): Promise<string> {
    console.log(`[Mixer] 🧱 Inizio mixaggio sessione ${sessionId} (Modalità Float 32-bit)...`);

    const recordings = getSessionRecordings(sessionId);
    const sessionStart = getSessionStartTime(sessionId);

    if (!recordings.length || !sessionStart) {
        throw new Error("Nessuna registrazione trovata per questa sessione.");
    }

    // 1. Download e Preparazione
    console.log(`[Mixer] 📥 Verifica di ${recordings.length} tracce audio...`);

    const validFiles: { path: string, delay: number }[] = [];

    for (const rec of recordings) {
        const filePath = path.join(RECORDINGS_DIR, rec.filename);

        // Verifica esistenza, altrimenti scarica dal cloud
        if (!fs.existsSync(filePath)) {
            console.log(`[Mixer] ☁️ Scaricamento ${rec.filename} da Oracle...`);
            const success = await downloadFromOracle(rec.filename, filePath, sessionId);
            if (!success) {
                console.warn(`[Mixer] ⚠️ File mancante impossibile da recuperare: ${rec.filename}`);
                continue;
            }
        }

        validFiles.push({
            path: filePath,
            delay: Math.max(0, rec.timestamp - sessionStart)
        });
    }

    if (validFiles.length === 0) throw new Error("Nessun file valido disponibile per il mix.");

    // File "Accumulatore" temporaneo (WAV 32-bit Float)
    let accumulatorPath = path.join(TEMP_DIR, `acc_${sessionId}.wav`);
    const stepOutputPath = path.join(TEMP_DIR, `step_${sessionId}.wav`);

    // Pulizia preventiva
    if (fs.existsSync(accumulatorPath)) fs.unlinkSync(accumulatorPath);

    // 2. Loop a Blocchi (The Accumulator Loop)
    let processedCount = 0;

    // Ordiniamo i file per timestamp per logica temporale (opzionale ma pulito)
    validFiles.sort((a, b) => a.delay - b.delay);

    while (processedCount < validFiles.length) {
        const batch = validFiles.slice(processedCount, processedCount + BATCH_SIZE);
        const isFirstBatch = processedCount === 0;

        console.log(`[Mixer] 🔄 Mixing blocco ${Math.ceil((processedCount + 1) / BATCH_SIZE)}: ${batch.length} file...`);

        await processBatch(batch, accumulatorPath, stepOutputPath, isFirstBatch);

        // Scambio file: l'output diventa il nuovo input (accumulatore)
        if (!isFirstBatch) {
            fs.renameSync(stepOutputPath, accumulatorPath);
        }

        processedCount += batch.length;
        if (global.gc) global.gc();
    }

    // 3. Mastering Finale (Normalizzazione + Encoding MP3)
    console.log(`[Mixer] 🎛️  Mastering finale (Loudness EBU R128)...`);
    const finalMp3Path = path.join(OUTPUT_DIR, `MASTER-${sessionId}.mp3`);

    await convertToMp3(accumulatorPath, finalMp3Path);

    // 4. Cleanup
    try {
        if (fs.existsSync(accumulatorPath)) fs.unlinkSync(accumulatorPath);
        if (fs.existsSync(stepOutputPath)) fs.unlinkSync(stepOutputPath);
    } catch (e) {
        console.warn("[Mixer] Warning cleanup:", e);
    }

    console.log(`[Mixer] ✅ Master creato con successo: ${finalMp3Path}`);
    return finalMp3Path;
}

/**
 * Esegue il mix di un batch usando matematica a virgola mobile
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

        // Input 0: Accumulatore (se esiste)
        if (!isFirstBatch) {
            args.push('-i', accumulatorPath);
        }

        // Input successivi: File del batch
        files.forEach((f) => {
            args.push('-i', f.path);
        });

        // Costruzione Filter Complex
        const outputTags: string[] = [];
        let inputIndex = 0;

        // Gestione Accumulatore nel filtro
        if (!isFirstBatch) {
            // L'accumulatore è già mixato, lo passiamo come [0]
            outputTags.push('[0]');
            inputIndex++;
        }

        // Gestione Nuovi File
        files.forEach((f, idx) => {
            const currentIdx = inputIndex + idx; // Indice reale in ffmpeg
            const tag = `s${idx}`;

            // adelay accetta millisecondi. Se delay è 0, ffmpeg potrebbe lamentarsi su versioni vecchie,
            // ma adelay=0 solitamente è valido. Per sicurezza usiamo un valore minimo o stringa.
            const safeDelay = Math.max(0, Math.floor(f.delay));

            // Sintassi adelay: delay_ch1|delay_ch2
            filterComplex += `[${currentIdx}]adelay=${safeDelay}|${safeDelay}[${tag}];`;
            outputTags.push(`[${tag}]`);
        });

        const totalInputs = outputTags.length;

        if (totalInputs === 1) {
            // Caso degenere: solo un file (primo batch di 1 elemento)
            // Copia diretta con conversione formato
            filterComplex += `${outputTags[0]}aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=stereo[out]`;
        } else {
            // Mix: normalize=0 è fondamentale per non abbassare il volume.
            // Poiché usiamo float (flt), i valori > 1.0 (clipping) sono preservati e gestiti dopo.
            filterComplex += `${outputTags.join('')}amix=inputs=${totalInputs}:dropout_transition=0:normalize=0,aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=stereo[out]`;
        }

        const destination = isFirstBatch ? accumulatorPath : outputPath;

        const ffmpegArgs = [
            ...args,
            '-filter_complex', filterComplex,
            '-map', '[out]',
            // PARAMETRI CRITICI PER LA QUALITÀ:
            '-c:a', 'pcm_f32le', // 32-bit Floating Point (No Clipping)
            '-ar', '48000',      // Sample Rate fisso
            destination,
            '-y'
        ];

        const ffmpeg = spawn('ffmpeg', ffmpegArgs);

        ffmpeg.stderr.on('data', (data) => {
            // Decommentare per debug profondo
            // console.error(`[FFmpeg]: ${data}`);
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg batch mix failed with code ${code}`));
        });

        ffmpeg.on('error', (err) => reject(err));
    });
}

/**
 * Converte il Master WAV Float in MP3 con Normalizzazione Loudness
 */
function convertToMp3(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        // Filtro loudnorm:
        // I=-16 (Target LUFS podcast standard)
        // TP=-1.5 (True Peak, lascia margine per evitare distorsione nella conversione mp3)
        // LRA=11 (Loudness Range, dinamica naturale per il parlato)

        const ffmpeg = spawn('ffmpeg', [
            '-i', inputPath,
            '-filter:a', 'loudnorm=I=-16:TP=-1.5:LRA=11',
            '-c:a', 'libmp3lame',
            '-b:a', MASTER_BITRATE,
            '-ar', '48000',
            outputPath,
            '-y'
        ]);

        ffmpeg.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Final MP3 conversion failed with code ${code}`));
        });

        ffmpeg.on('error', reject);
    });
}
