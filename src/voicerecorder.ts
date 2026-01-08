import {
    joinVoiceChannel,
    EndBehaviorType,
    getVoiceConnection,
    VoiceConnection
} from '@discordjs/voice';
import { VoiceBasedChannel } from 'discord.js';
import * as fs from 'fs';
import * as prism from 'prism-media';
import * as path from 'path';
import { Transform } from 'stream';
import { exec } from 'child_process';
import { promisify } from 'util';
import { addRecording, updateRecordingStatus, getCampaignLocation, getActiveCampaign } from './db';
import { audioQueue } from './queue';
import { uploadToOracle } from './backupService';

const execAsync = promisify(exec);

// --- SILENCE INJECTOR ---
class SilenceInjector extends Transform {
    private lastTime: number = 0;
    public lastPacketTime: number = Date.now();

    constructor() {
        super();
    }

    _transform(chunk: Buffer, _encoding: string, callback: Function) {
        const now = Date.now();
        this.lastPacketTime = now;

        if (this.lastTime > 0) {
            const delta = now - this.lastTime;
            if (delta > 40) {
                const silenceMs = delta - 20;
                if (silenceMs > 0) {
                    const bytesPerMs = 192; // 48kHz * 2ch * 2bytes
                    const silenceBytes = Math.floor(silenceMs * bytesPerMs);
                    const alignedBytes = silenceBytes - (silenceBytes % 4);

                    if (alignedBytes > 0) {
                        const silenceBuffer = Buffer.alloc(alignedBytes, 0);
                        this.push(silenceBuffer);
                    }
                }
            }
        }

        this.lastTime = now;
        this.push(chunk);
        callback();
    }
}

// Strutture Dati
interface ActiveStream {
    out: fs.WriteStream;
    decoder: prism.opus.Decoder;
    encoder: prism.FFmpeg;
    silenceInjector: SilenceInjector;
    opusStream: any;
    currentPath: string;
    connectionStartTime: number; // Tempo inizio connessione utente (per calcolo delay)
    sessionId: string;
    rotationTimer?: NodeJS.Timeout;
    chunks: string[]; // Lista dei file parziali generati
}

interface SessionFile {
    path: string;
    startTime: number;
    userId: string;
}

const activeStreams = new Map<string, ActiveStream>();
const connectionErrors = new Map<string, number>();
const pausedGuilds = new Set<string>();

// Mappe per Master Mix
const sessionStartTimes = new Map<string, number>(); // SessionId -> Timestamp (Time Zero)
const completedSessionFiles = new Map<string, SessionFile[]>(); // SessionId -> Files

const CHUNK_DURATION_MS = 5 * 60 * 1000; // 5 Minuti
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 Minuti

// Helper per creare l'encoder
function createEncoder(): prism.FFmpeg {
    return new prism.FFmpeg({
        args: [
            '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', '-',
            '-codec:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3',
        ],
    });
}

export function pauseRecording(guildId: string) {
    pausedGuilds.add(guildId);
    console.log(`[Recorder] ⏸️ Registrazione in PAUSA per Guild ${guildId}`);
    
    const keysToClose: string[] = [];
    for (const [key] of activeStreams) {
        if (key.startsWith(`${guildId}-`)) {
            keysToClose.push(key);
        }
    }
    for (const key of keysToClose) {
        closeStream(key);
    }
}

export function resumeRecording(guildId: string) {
    pausedGuilds.delete(guildId);
    console.log(`[Recorder] ▶️ Registrazione RIPRESA per Guild ${guildId}`);
}

export function isRecordingPaused(guildId: string): boolean {
    return pausedGuilds.has(guildId);
}

export async function connectToChannel(channel: VoiceBasedChannel, sessionId: string) {
    if (!channel.guild) return;
    const guildId = channel.guild.id;
    pausedGuilds.delete(guildId);

    // 1. Gestione Time Zero
    if (!sessionStartTimes.has(sessionId)) {
        sessionStartTimes.set(sessionId, Date.now());
        console.log(`[Recorder] 🕒 Tempo Zero fissato per sessione ${sessionId}: ${sessionStartTimes.get(sessionId)}`);
    }

    const connection: VoiceConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });

    console.log(`🎙️  Connesso al canale: ${channel.name} (Sessione: ${sessionId}, Guild: ${guildId})`);

    connection.receiver.speaking.on('start', (userId: string) => {
        if (pausedGuilds.has(guildId)) return;
        const user = channel.client.users.cache.get(userId);
        if (user?.bot) return; 
        createListeningStream(connection.receiver, userId, sessionId, guildId);
    });
}

function createListeningStream(receiver: any, userId: string, sessionId: string, guildId: string) {
    const streamKey = `${guildId}-${userId}`;
    if (activeStreams.has(streamKey)) return;

    const lastError = connectionErrors.get(streamKey) || 0;
    if (Date.now() - lastError < 1000) return; 

    console.log(`[Recorder] 🆕 Creazione nuovo stream persistente per ${userId}`);

    const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.Manual },
    });

    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const silenceInjector = new SilenceInjector();
    
    let encoder = createEncoder();

    const getNewFile = () => {
        const filename = `${userId}-${Date.now()}.mp3`;
        const filepath = path.join(__dirname, '..', 'recordings', filename);
        const recordingsDir = path.dirname(filepath);
        if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });
        const out = fs.createWriteStream(filepath);
        return { out, filepath, filename };
    };

    let { out, filepath, filename } = getNewFile();
    const connectionStartTime = Date.now(); // Start time di QUESTA connessione

    const handleError = (err: Error, source: string) => {
        if (err.message === 'Premature close') return;
        console.warn(`⚠️ Errore Audio (${source}) per utente ${userId}: ${err.message}`);
        const currentStream = activeStreams.get(streamKey);
        if(currentStream) closeStream(streamKey); 
        connectionErrors.set(streamKey, Date.now());
    };

    decoder.on('error', (e) => handleError(e, 'Decoder'));
    encoder.on('error', (e) => handleError(e, 'Encoder'));
    silenceInjector.on('error', (e) => handleError(e, 'SilenceInjector'));
    opusStream.on('error', (e: Error) => handleError(e, 'OpusStream'));

    opusStream.pipe(decoder).pipe(silenceInjector).pipe(encoder).pipe(out);

    // ROTAZIONE FILE (Chunking)
    const rotationTimer = setInterval(async () => {
        const streamData = activeStreams.get(streamKey);
        if (!streamData) {
            clearInterval(rotationTimer);
            return;
        }

        if (Date.now() - streamData.silenceInjector.lastPacketTime > IDLE_TIMEOUT_MS) {
            console.log(`[Recorder] 💤 Stream inattivo per ${userId}, chiusura.`);
            closeStream(streamKey);
            return;
        }

        console.log(`[Recorder] 🔄 Rotazione file per ${userId} (Nuovo Encoder)...`);

        const oldEncoder = streamData.encoder;
        const oldOut = streamData.out;
        const oldPath = streamData.currentPath;
        const oldName = path.basename(oldPath);

        streamData.silenceInjector.unpipe(oldEncoder);
        
        oldEncoder.end();
        oldOut.on('finish', () => {
             saveChunkBackup(oldPath, oldName, sessionId).catch(console.error);
        });

        const newFile = getNewFile();
        const newEncoder = createEncoder();

        streamData.out = newFile.out;
        streamData.encoder = newEncoder;
        streamData.currentPath = newFile.filepath;
        // NOTA: Non aggiorniamo connectionStartTime!
        streamData.chunks.push(newFile.filename);

        newEncoder.on('error', (e) => handleError(e, 'Encoder-Rotated'));
        streamData.out.on('error', (e) => handleError(e, 'FileWrite-Rotated'));

        streamData.silenceInjector.pipe(newEncoder).pipe(streamData.out);

    }, CHUNK_DURATION_MS);

    activeStreams.set(streamKey, { 
        out, decoder, encoder, silenceInjector, opusStream,
        currentPath: filepath, connectionStartTime, sessionId, rotationTimer,
        chunks: [filename]
    });

    console.log(`[Recorder] ⏺️  Registrazione CONTINUA avviata per ${userId} (Chunk: 5min)`);
}

async function closeStream(streamKey: string) {
    const stream = activeStreams.get(streamKey);
    if (!stream) return;

    console.log(`[Recorder] 🛑 Chiusura stream ${streamKey}`);

    if (stream.rotationTimer) clearInterval(stream.rotationTimer);

    try { stream.opusStream.destroy(); } catch {}
    try { stream.decoder.destroy(); } catch {}
    try { stream.silenceInjector.destroy(); } catch {}
    try { stream.encoder.destroy(); } catch {}

    activeStreams.delete(streamKey); // Rimuovi subito dalla mappa

    return new Promise<void>((resolve) => {
        try {
            stream.out.end();
            stream.out.on('finish', async () => {
                const filename = path.basename(stream.currentPath);
                await saveChunkBackup(stream.currentPath, filename, stream.sessionId);
                
                // AVVIO MERGE FINALE
                const guildId = streamKey.split('-')[0];
                const userId = streamKey.split('-')[1];
                await mergeAndUploadSession(userId, stream.chunks, stream.sessionId, guildId, stream.connectionStartTime);
                resolve();
            });
            stream.out.on('error', () => resolve()); // Risolvi comunque in caso di errore
        } catch {
            resolve();
        }
    });
}

async function saveChunkBackup(filePath: string, fileName: string, sessionId: string) {
    try {
        const stats = fs.statSync(filePath);
        if (stats.size < 1000) {
            fs.unlinkSync(filePath);
            return;
        }
        const customKey = `recordings/${sessionId}/chunks/${fileName}`;
        await uploadToOracle(filePath, fileName, sessionId, customKey);
        console.log(`[Recorder] 🛡️ Chunk di sicurezza caricato: ${fileName}`);
    } catch (e) {
        console.error(`[Recorder] ⚠️ Errore backup chunk ${fileName}:`, e);
    }
}

async function mergeAndUploadSession(userId: string, chunks: string[], sessionId: string, guildId: string, startTime: number) {
    if (chunks.length === 0) return;

    const recordingsDir = path.join(__dirname, '..', 'recordings');
    const validChunks = chunks.filter(f => fs.existsSync(path.join(recordingsDir, f)));

    if (validChunks.length === 0) return;

    console.log(`[Recorder] 🔗 Avvio merge e normalizzazione di ${validChunks.length} chunk per ${userId}...`);

    const outputFilename = `FULL-${userId}-${Date.now()}.mp3`;
    const outputPath = path.join(recordingsDir, outputFilename);
    const listPath = path.join(recordingsDir, `list-${sessionId}-${userId}-${Date.now()}.txt`);

    const fileContent = validChunks.map(f => `file '${path.join(recordingsDir, f)}'`).join('\n');
    fs.writeFileSync(listPath, fileContent);

    // Concatena + Normalizza
    const command = `ffmpeg -f concat -safe 0 -i "${listPath}" -filter:a loudnorm -c:a libmp3lame -b:a 64k "${outputPath}"`;

    try {
        await execAsync(command);
        try { fs.unlinkSync(listPath); } catch {}

        console.log(`[Recorder] ✅ Merge e Normalizzazione completati: ${outputFilename}`);

        // Aggiungi alla lista per il Master Mix
        if (!completedSessionFiles.has(sessionId)) {
            completedSessionFiles.set(sessionId, []);
        }
        completedSessionFiles.get(sessionId)?.push({
            path: outputPath,
            startTime: startTime,
            userId: userId
        });

        // Processa il file (DB, Upload, Trascrizione)
        await processFinalFile(userId, outputPath, outputFilename, sessionId, guildId);

        // Pulizia Chunk Locali
        for (const chunk of validChunks) {
            try { fs.unlinkSync(path.join(recordingsDir, chunk)); } catch {}
        }

    } catch (error) {
        console.error(`[Recorder] ❌ Errore Merge/Normalizzazione FFmpeg:`, error);
    }
}

async function processFinalFile(userId: string, filePath: string, fileName: string, sessionId: string, guildId: string) {
    const loc = getCampaignLocation(guildId);
    const campaign = getActiveCampaign(guildId);
    const timestamp = Date.now();

    addRecording(sessionId, fileName, filePath, userId, timestamp, loc?.macro, loc?.micro, campaign?.current_year);

    const customKey = `recordings/${sessionId}/full/${fileName}`;
    try {
        await uploadToOracle(filePath, fileName, sessionId, customKey);
        updateRecordingStatus(fileName, 'SECURED');
    } catch (e) {
        console.error(`[Recorder] ❌ Errore upload FULL file:`, e);
    }

    await audioQueue.add('transcribe-job', {
        sessionId,
        fileName,
        filePath,
        userId
    }, {
        jobId: fileName,
        attempts: 3,
        removeOnComplete: true
    });

    console.log(`[Recorder] 🚀 Sessione completa inviata alla trascrizione: ${fileName}`);
}

// --- MASTER MIX LOGIC ---

async function createMasterMix(sessionId: string) {
    const files = completedSessionFiles.get(sessionId);
    const sessionStart = sessionStartTimes.get(sessionId);

    if (!files || files.length === 0 || !sessionStart) {
        console.log(`[MasterMix] ⚠️ Nessun file o sessionStart mancante per ${sessionId}. Skip.`);
        return;
    }

    console.log(`[MasterMix] 🎛️ Avvio creazione Master Mix per sessione ${sessionId} (${files.length} tracce)...`);

    // Ordina per startTime
    files.sort((a, b) => a.startTime - b.startTime);

    const inputs: string[] = [];
    const delays: string[] = [];
    
    files.forEach((file, index) => {
        inputs.push(`-i "${file.path}"`);
        // Calcola delay in ms
        const delay = Math.max(0, file.startTime - sessionStart);
        delays.push(`[${index}]adelay=${delay}|${delay}[s${index}]`);
    });

    const outputFilename = `MASTER-${sessionId}.mp3`;
    const outputPath = path.join(__dirname, '..', 'recordings', outputFilename);

    // Costruzione filtro complesso
    // [0]adelay=...[s0];[1]adelay=...[s1];...[s0][s1]...amix=inputs=N:dropout_transition=0:normalize=0[mixed];[mixed]loudnorm=...[out]
    const inputTags = files.map((_, i) => `[s${i}]`).join('');
    const filterComplex = `"${delays.join(';')};${inputTags}amix=inputs=${files.length}:dropout_transition=0:normalize=0[mixed];[mixed]loudnorm=I=-16:TP=-1.5:LRA=11[out]"`;

    const command = `ffmpeg ${inputs.join(' ')} -filter_complex ${filterComplex} -map "[out]" -c:a libmp3lame -b:a 128k -y "${outputPath}"`;

    try {
        await execAsync(command);
        console.log(`[MasterMix] 🎹 Master Mix creato con successo: ${outputFilename}`);

        // Upload Master
        const customKey = `recordings/${sessionId}/master/${outputFilename}`;
        await uploadToOracle(outputPath, outputFilename, sessionId, customKey);
        
        // Cleanup locale dei fragment (opzionale, se vogliamo risparmiare spazio subito)
        // files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
        
        // Cleanup mappe
        completedSessionFiles.delete(sessionId);
        sessionStartTimes.delete(sessionId);

    } catch (error) {
        console.error(`[MasterMix] ❌ Errore creazione Master Mix:`, error);
    }
}

export async function disconnect(guildId: string): Promise<boolean> {
    const connection = getVoiceConnection(guildId);
    if (connection) {
        console.log(`[Recorder] Disconnessione richiesta per Guild ${guildId}...`);
        
        // Identifica sessione (prendiamo la prima che troviamo associata a questa guild negli stream attivi)
        // O meglio, dovremmo averla salvata. Ma activeStreams ha sessionId.
        let sessionId: string | undefined;
        const keysToClose: string[] = [];
        
        for (const [key, stream] of activeStreams) {
            if (key.startsWith(`${guildId}-`)) {
                keysToClose.push(key);
                if (!sessionId) sessionId = stream.sessionId;
            }
        }

        // Chiudi tutti gli stream e attendi i merge
        const closePromises = keysToClose.map(key => closeStream(key));
        await Promise.all(closePromises);

        // Attendi un attimo per sicurezza (opzionale, ma aiuta se ci sono race conditions su FS)
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Genera Master Mix
        if (sessionId) {
            await createMasterMix(sessionId);
        }

        connection.destroy();
        console.log("👋 Disconnesso.");
        return true;
    }
    return false;
}

export function isFileActive(fullPath: string): boolean {
    const target = path.resolve(fullPath);
    for (const data of activeStreams.values()) {
        if (path.resolve(data.currentPath) === target) return true;
    }
    return false;
}

export function wipeLocalFiles() {
    const recordingsDir = path.join(__dirname, '..', 'recordings');
    if (fs.existsSync(recordingsDir)) {
        try {
            const files = fs.readdirSync(recordingsDir);
            for (const file of files) {
                if (file.startsWith('.')) continue;
                if (isFileActive(path.join(recordingsDir, file))) continue;
                fs.unlinkSync(path.join(recordingsDir, file));
            }
            console.log(`[Recorder] 🧹 File locali eliminati.`);
        } catch (e) {
            console.error("[Recorder] ❌ Errore durante la pulizia dei file locali:", e);
        }
    }
}
