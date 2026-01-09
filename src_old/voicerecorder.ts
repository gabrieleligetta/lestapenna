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
import { Transform, TransformCallback } from 'stream';
import { exec } from 'child_process';
import { promisify } from 'util';
import { addRecording, updateRecordingStatus, getCampaignLocation, getActiveCampaign, createSession, getSessionStartTime } from './db';
import { audioQueue } from './queue';
import { uploadToOracle } from './backupService';
import { mixSessionAudio } from './sessionMixer';

const execAsync = promisify(exec);

// --- CONFIGURAZIONE AUDIO ---
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BIT_DEPTH = 16;
// Byte al secondo: 48000 * 2 canali * 2 bytes (16bit) = 192,000 bytes/sec
const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8)) / 1000;

// Tolleranza Jitter: Se il gap è minore di 40ms, lo ignoriamo (è normale latenza di rete)
const JITTER_THRESHOLD_MS = 40;
// Massimo silenzio iniettabile in un colpo solo (per evitare blocchi di memoria enormi)
const MAX_SILENCE_ALLOC_BYTES = 192000 * 10; // ~10 secondi max per chunk

// --- PCM SILENCE INJECTOR (Nuovo Sync Engine) ---
// Invece di usare RTP (rotto), usiamo il tempo di arrivo dei pacchetti decodificati.
class PcmSilenceInjector extends Transform {
    private lastChunkTime: number = 0;
    private firstPacketReceived: boolean = false;

    constructor() {
        super();
    }

    _transform(chunk: Buffer, encoding: string, callback: TransformCallback) {
        const now = Date.now();

        if (!this.firstPacketReceived) {
            this.firstPacketReceived = true;
            this.lastChunkTime = now;
            this.push(chunk);
            callback();
            return;
        }

        // Calcola quanto tempo è passato dall'ultimo chunk processato
        const deltaMs = now - this.lastChunkTime;

        // Calcola la durata (in ms) del chunk audio che abbiamo appena ricevuto
        // Esempio: un chunk di 3840 bytes dura 20ms a 48khz stereo 16bit
        const chunkDurationMs = chunk.length / BYTES_PER_MS;

        // Tempo atteso: il tempo dell'ultimo chunk + la sua durata.
        // Se 'now' è molto più avanti, significa che c'è stato silenzio.
        // Nota: Sottraiamo chunkDurationMs perché 'now' è la fine del gap, non l'inizio.
        // Una stima più semplice per flussi realtime è guardare il gap puro.

        // Semplificazione Robusta:
        // Se tra la fine dell'ultimo pacchetto e l'arrivo di questo sono passati
        // più ms del previsto, riempiamo il buco.
        // Bisogna considerare che il processamento del chunk precedente ha "coperto" del tempo.

        // Poiché non conosciamo la durata esatta del chunk precedente qui (non l'abbiamo salvata),
        // usiamo un approccio differenziale sul timestamp di arrivo.

        // Gap rilevato = Tempo Attuale - (Tempo Ultimo Chunk + Durata Stimata Standard 20ms)
        // Usiamo un approccio conservativo: se il delta è > JITTER_THRESHOLD_MS + 20ms standard

        if (deltaMs > (JITTER_THRESHOLD_MS + 20)) {
            // C'è un buco di silenzio.
            // Calcoliamo quanti millisecondi mancano.
            // Sottraiamo 20ms che è la durata "fisiologica" del pacchetto appena arrivato o del precedente.
            const silenceDurationMs = deltaMs - 20;

            if (silenceDurationMs > 0) {
                // Calcola quanti byte di silenzio servono
                const silenceBytes = Math.floor(silenceDurationMs * BYTES_PER_MS);

                // Allinea a 4 byte (block align per stereo 16bit) per evitare rumore statico
                const alignedSilenceBytes = silenceBytes - (silenceBytes % 4);

                if (alignedSilenceBytes > 0) {
                    // Crea buffer di silenzio (pieno di zeri)
                    // Lo spezziamo se è troppo grande per non far crashare la memoria
                    let remaining = alignedSilenceBytes;
                    while (remaining > 0) {
                        const size = Math.min(remaining, MAX_SILENCE_ALLOC_BYTES);
                        this.push(Buffer.alloc(size));
                        remaining -= size;
                    }
                }
            }
        }

        this.lastChunkTime = now;
        this.push(chunk);
        callback();
    }
}

// Strutture Dati
interface ActiveStream {
    out: fs.WriteStream;
    decoder: prism.opus.Decoder;
    encoder: prism.FFmpeg;
    silenceInjector: PcmSilenceInjector;
    opusStream: any;
    currentPath: string;
    connectionStartTime: number;
    sessionId: string;
    rotationTimer?: NodeJS.Timeout;
    chunks: string[];
    lastActivity: number; // Per timeout inattività
}

const activeStreams = new Map<string, ActiveStream>();
const connectionErrors = new Map<string, number>();
const pausedGuilds = new Set<string>();

const CHUNK_DURATION_MS = 5 * 60 * 1000; // 5 Minuti
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 Minuti

// Encoder FFmpeg per salvare su disco
// Aumentato bitrate a 128k per "Qualità Podcast"
function createEncoder(): prism.FFmpeg {
    return new prism.FFmpeg({
        args: [
            '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', '-',
            '-codec:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3',
        ],
    });
}

export function pauseRecording(guildId: string) {
    pausedGuilds.add(guildId);
    console.log(`[Recorder] ⏸️ Registrazione in PAUSA per Guild ${guildId}`);
    // Chiude gli stream attuali; riprenderanno nuovi file al resume
    const keysToClose: string[] = [];
    for (const [key] of activeStreams) {
        if (key.startsWith(`${guildId}-`)) keysToClose.push(key);
    }
    keysToClose.forEach(closeStream);
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

    const existingStart = getSessionStartTime(sessionId);
    if (!existingStart) {
        const campaign = getActiveCampaign(guildId);
        createSession(sessionId, guildId, campaign ? campaign.id : null, Date.now());
        console.log(`[Recorder] 🕒 Tempo Zero fissato per sessione ${sessionId}`);
    }

    const connection: VoiceConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });

    console.log(`🎙️  Connesso al canale: ${channel.name} (Sessione: ${sessionId})`);

    // Nota: Abbiamo rimosso ensurePacketMonitor perché non serve più.

    connection.receiver.speaking.on('start', (userId: string) => {
        if (pausedGuilds.has(guildId)) return;
        const user = channel.client.users.cache.get(userId);
        if (user?.bot) return;

        // Se lo stream esiste già, non facciamo nulla (il PcmSilenceInjector gestirà il buco)
        // Se non esiste (o è scaduto per timeout), lo creiamo.
        createListeningStream(connection, userId, sessionId, guildId);
    });
}

function createListeningStream(connection: VoiceConnection, userId: string, sessionId: string, guildId: string) {
    const streamKey = `${guildId}-${userId}`;
    if (activeStreams.has(streamKey)) return;

    // Debounce connessioni rapide
    const lastError = connectionErrors.get(streamKey) || 0;
    if (Date.now() - lastError < 1000) return;

    console.log(`[Recorder] 🆕 Creazione stream per ${userId}`);

    const receiver = connection.receiver;

    // Sottoscrizione allo stream OPUS di Discord
    const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.Manual },
    });

    // PIPELINE NUOVA:
    // 1. Opus Decoder: Converte pacchetti Opus compressi in PCM Raw
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

    // 2. Silence Injector: Inietta byte zero se rileva buchi temporali nel PCM
    const silenceInjector = new PcmSilenceInjector();

    // 3. Encoder: Converte PCM continuo (con silenzi) in MP3
    let encoder = createEncoder();

    const getNewFile = () => {
        const filename = `${userId}-${Date.now()}.mp3`;
        const filepath = path.join(__dirname, '..', 'recordings', filename);
        const recordingsDir = path.dirname(filepath);
        if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });
        return { out: fs.createWriteStream(filepath), filepath, filename };
    };

    let { out, filepath, filename } = getNewFile();
    const connectionStartTime = Date.now();

    const handleError = (err: Error, source: string) => {
        if (err.message === 'Premature close') return;
        console.warn(`⚠️ Errore Audio (${source}) per ${userId}: ${err.message}`);
        // Invece di chiudere tutto brutalmente, proviamo a recuperare se è solo un errore encoder
        if (source === 'OpusStream') {
            closeStream(streamKey);
            connectionErrors.set(streamKey, Date.now());
        }
    };

    opusStream.on('error', (e: Error) => handleError(e, 'OpusStream'));
    decoder.on('error', (e) => handleError(e, 'Decoder'));
    silenceInjector.on('error', (e) => handleError(e, 'SilenceInjector'));
    encoder.on('error', (e) => handleError(e, 'Encoder'));

    // COSTRUZIONE PIPELINE
    // Opus (Discord) -> Decoder (PCM) -> Injector (PCM Filler) -> Encoder (MP3) -> File
    opusStream
        .pipe(decoder)
        .pipe(silenceInjector)
        .pipe(encoder)
        .pipe(out);

    // ROTAZIONE FILE (Ogni 5 minuti per sicurezza)
    const rotationTimer = setInterval(async () => {
        const streamData = activeStreams.get(streamKey);
        if (!streamData) {
            clearInterval(rotationTimer);
            return;
        }

        // Controllo Inattività (15 min)
        // Usiamo lastChunkTime dell'injector come riferimento
        const lastActivity = (streamData.silenceInjector as any).lastChunkTime || Date.now();
        if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
            console.log(`[Recorder] 💤 Timeout inattività per ${userId}.`);
            closeStream(streamKey);
            return;
        }

        // Rotazione
        const oldEncoder = streamData.encoder;
        const oldOut = streamData.out;
        const oldPath = streamData.currentPath;
        const oldName = path.basename(oldPath);

        // Disconnetti injector da encoder vecchio
        streamData.silenceInjector.unpipe(oldEncoder);

        oldEncoder.end();
        oldOut.on('finish', () => {
            saveChunkBackup(oldPath, oldName, sessionId).catch(console.error);
        });

        // Crea nuovi
        const newFile = getNewFile();
        const newEncoder = createEncoder();

        streamData.out = newFile.out;
        streamData.encoder = newEncoder;
        streamData.currentPath = newFile.filepath;
        streamData.chunks.push(newFile.filename);

        // Ricollega
        newEncoder.on('error', (e) => handleError(e, 'Encoder-Rotated'));
        streamData.out.on('error', (e) => handleError(e, 'FileWrite-Rotated')); // Fix typo precedente

        streamData.silenceInjector.pipe(newEncoder).pipe(streamData.out);

    }, CHUNK_DURATION_MS);

    activeStreams.set(streamKey, {
        out, decoder, encoder, silenceInjector, opusStream,
        currentPath: filepath, connectionStartTime, sessionId, rotationTimer,
        chunks: [filename],
        lastActivity: Date.now()
    });

    console.log(`[Recorder] ⏺️  Stream avviato per ${userId}`);
}

export async function closeUserStream(guildId: string, userId: string) {
    const streamKey = `${guildId}-${userId}`;
    if (activeStreams.has(streamKey)) await closeStream(streamKey);
}

async function closeStream(streamKey: string) {
    const stream = activeStreams.get(streamKey);
    if (!stream) return;

    if (stream.rotationTimer) clearInterval(stream.rotationTimer);

    // Distruggere la catena dall'inizio alla fine
    try { stream.opusStream.destroy(); } catch {}
    try { stream.decoder.destroy(); } catch {}
    try { stream.silenceInjector.destroy(); } catch {}
    try { stream.encoder.destroy(); } catch {}

    activeStreams.delete(streamKey);

    return new Promise<void>((resolve) => {
        if (stream.out && !stream.out.writableEnded) {
            stream.out.end();
            stream.out.on('finish', async () => {
                // Backup ultimo chunk
                const filename = path.basename(stream.currentPath);
                await saveChunkBackup(stream.currentPath, filename, stream.sessionId);

                // Merge Finale dell'utente
                const guildId = streamKey.split('-')[0];
                const userId = streamKey.split('-')[1];
                await mergeAndUploadSession(userId, stream.chunks, stream.sessionId, guildId, stream.connectionStartTime);
                resolve();
            });
            stream.out.on('error', () => resolve());
        } else {
            resolve();
        }
    });
}

// --- FUNZIONI BACKUP & MERGE (Invariate ma ottimizzate nel logging) ---

async function saveChunkBackup(filePath: string, fileName: string, sessionId: string) {
    try {
        if (!fs.existsSync(filePath)) return;
        const stats = fs.statSync(filePath);
        if (stats.size < 1000) { // Ignora file < 1KB (vuoti o corrotti)
            try { fs.unlinkSync(filePath); } catch {}
            return;
        }
        const customKey = `recordings/${sessionId}/chunks/${fileName}`;
        await uploadToOracle(filePath, fileName, sessionId, customKey);
    } catch (e) {
        console.error(`[Recorder] ⚠️ Errore backup chunk ${fileName}:`, e);
    }
}

async function mergeAndUploadSession(userId: string, chunks: string[], sessionId: string, guildId: string, startTime: number) {
    const recordingsDir = path.join(__dirname, '..', 'recordings');
    // Filtra chunk esistenti e validi
    const validChunks = chunks.filter(f => fs.existsSync(path.join(recordingsDir, f)));

    if (validChunks.length === 0) return;

    console.log(`[Recorder] 🔗 Merge ${validChunks.length} files per ${userId}...`);

    const outputFilename = `FULL-${userId}-${Date.now()}.mp3`;
    const outputPath = path.join(recordingsDir, outputFilename);
    const listPath = path.join(recordingsDir, `list-${sessionId}-${userId}-${Date.now()}.txt`);

    const fileContent = validChunks.map(f => `file '${path.join(recordingsDir, f)}'`).join('\n');
    fs.writeFileSync(listPath, fileContent);

    // FFmpeg Merge + Loudnorm (Normalizzazione Audio EBU R128)
    // Questo è fondamentale per la qualità podcast: livella il volume automaticamente
    const command = `ffmpeg -f concat -safe 0 -i "${listPath}" -filter:a loudnorm -c:a libmp3lame -b:a 128k "${outputPath}"`;

    try {
        await execAsync(command);
        try { fs.unlinkSync(listPath); } catch {}

        await processFinalFile(userId, outputPath, outputFilename, sessionId, guildId, startTime);

        // Pulizia
        for (const chunk of validChunks) {
            try { fs.unlinkSync(path.join(recordingsDir, chunk)); } catch {}
        }
    } catch (error) {
        console.error(`[Recorder] ❌ Errore FFmpeg Merge:`, error);
    }
}

async function processFinalFile(userId: string, filePath: string, fileName: string, sessionId: string, guildId: string, startTime: number) {
    const loc = getCampaignLocation(guildId);
    const campaign = getActiveCampaign(guildId);

    addRecording(sessionId, fileName, filePath, userId, startTime, loc?.macro, loc?.micro, campaign?.current_year);

    const customKey = `recordings/${sessionId}/full/${fileName}`;
    try {
        await uploadToOracle(filePath, fileName, sessionId, customKey);
        updateRecordingStatus(fileName, 'SECURED');
    } catch (e) {
        console.error(`[Recorder] ❌ Errore upload FULL:`, e);
    }

    await audioQueue.add('transcribe-job', {
        sessionId,
        fileName,
        filePath,
        userId
    }, { jobId: fileName, attempts: 3, removeOnComplete: true });

    console.log(`[Recorder] ✅ Traccia utente salvata e inviata: ${fileName}`);
}

export async function disconnect(guildId: string): Promise<boolean> {
    const connection = getVoiceConnection(guildId);
    if (connection) {
        console.log(`[Recorder] Disconnessione Guild ${guildId}...`);

        let sessionId: string | undefined;
        const keysToClose: string[] = [];

        for (const [key, stream] of activeStreams) {
            if (key.startsWith(`${guildId}-`)) {
                keysToClose.push(key);
                if (!sessionId) sessionId = stream.sessionId;
            }
        }

        const closePromises = keysToClose.map(key => closeStream(key));
        await Promise.all(closePromises);

        // Attendi che i file system si assestino
        await new Promise(resolve => setTimeout(resolve, 1500));

        if (sessionId) {
            try {
                // Chiama il mixer finale (assume che esista sessionMixer.ts)
                const masterPath = await mixSessionAudio(sessionId);
                if (masterPath) {
                    const outputFilename = path.basename(masterPath);
                    const customKey = `recordings/${sessionId}/master/${outputFilename}`;
                    await uploadToOracle(masterPath, outputFilename, sessionId, customKey);
                    console.log(`[Recorder] 🎹 Master Mix creato: ${outputFilename}`);
                }
            } catch (e) {
                console.error(`[Recorder] ❌ Errore Master Mix:`, e);
            }
        }

        connection.destroy();
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
            console.log(`[Recorder] 🧹 Pulizia file completata.`);
        } catch (e) {
            console.error("[Recorder] ❌ Errore wipe:", e);
        }
    }
}
