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
import { spawn, ChildProcess } from 'child_process';
import { addRecording, updateRecordingStatus, getCampaignLocation, getActiveCampaign, getSessionRecordings } from '../db';
import { audioQueue } from './queue';
import { uploadToOracle } from './backup';
import { monitor } from '../monitor';
import { mixSessionAudio } from './sessionMixer';

// ✅ CLASSE SILENCE INJECTOR OTTIMIZZATA (Zero-Alloc)
class SilenceInjector extends Transform {
    private lastPacketTime: number;
    private readonly frameSize: number = 3840; // 20ms @ 48kHz stereo 16-bit
    private readonly bytesPerMs: number = 192; // 48000 * 2 * 2 / 1000
    private isFirstPacket: boolean = true;
    private silenceInjected: number = 0;

    // Buffer statico di ~1 secondo di silenzio (riutilizzabile)
    // 192 bytes/ms * 1000ms = 192000 bytes
    private static readonly ZERO_BUFFER = Buffer.alloc(192000);

    constructor() {
        super();
        this.lastPacketTime = Date.now();
    }

    _transform(chunk: Buffer, encoding: string, callback: TransformCallback): void {
        const now = Date.now();

        if (this.isFirstPacket) {
            this.isFirstPacket = false;
            this.lastPacketTime = now;
            this.push(chunk);
            callback();
            return;
        }

        const timeDelta = now - this.lastPacketTime;
        const expectedBytes = timeDelta * this.bytesPerMs;

        // Inietta silenzio se il gap è significativo (> 1 chunk + tolleranza jitter)
        // La tolleranza deve essere INFERIORE a 1 frame (20ms) per rilevare la perdita di un singolo pacchetto.
        // Impostiamo tolleranza a mezza frame (10ms).
        const jitterToleranceBytes = this.frameSize / 2;

        if (expectedBytes > (chunk.length + jitterToleranceBytes)) {
            const missingBytes = Math.floor(expectedBytes - chunk.length);
            const alignedMissingBytes = Math.floor(missingBytes / this.frameSize) * this.frameSize;

            if (alignedMissingBytes > 0) {
                this.silenceInjected += alignedMissingBytes;

                // Logica di invio a blocchi per evitare allocazioni
                let remainingToSend = alignedMissingBytes;
                const maxChunkSize = SilenceInjector.ZERO_BUFFER.length;

                while (remainingToSend > 0) {
                    const chunkSize = Math.min(remainingToSend, maxChunkSize);
                    // Usa subarray che crea un riferimento (non copia memoria)
                    this.push(SilenceInjector.ZERO_BUFFER.subarray(0, chunkSize));
                    remainingToSend -= chunkSize;
                }
            }
        }

        this.push(chunk);
        this.lastPacketTime = now;
        callback();
    }

    getSilenceInjectedMs(): number {
        return Math.floor(this.silenceInjected / this.bytesPerMs);
    }
}

// Struttura per tracciare lo stato completo dello stream
interface ActiveStream {
    ffmpeg: ChildProcess;
    decoder: prism.opus.Decoder;
    silenceInjector: SilenceInjector;
    currentPath: string;
    sessionId: string;
}

// Mappa aggiornata: UserId -> Dati Stream
const activeStreams = new Map<string, ActiveStream>();
const connectionErrors = new Map<string, number>();
const pausedGuilds = new Set<string>();
const guildToSession = new Map<string, string>();

// ✅ NUOVO: Tracking file in elaborazione
const pendingFileProcessing = new Map<string, Set<string>>(); // guildId -> Set<fileName>
const fileProcessingResolvers = new Map<string, (() => void)[]>(); // guildId -> resolver callbacks

// 1. Aggiungi variabile di stato in alto
let isStopping = false;

export function pauseRecording(guildId: string) {
    pausedGuilds.add(guildId);
    console.log(`[Recorder] ⏸️ Registrazione in PAUSA per Guild ${guildId}`);

    // Chiudiamo forzatamente gli stream attivi per evitare di registrare durante la pausa
    for (const [key, stream] of Array.from(activeStreams)) {
        if (key.startsWith(`${guildId}-`)) {
            try {
                stream.ffmpeg.stdin?.end();
            } catch (e) { }
            activeStreams.delete(key);
        }
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

    // Reset stato pausa alla connessione
    pausedGuilds.delete(guildId);

    // 🆕 TRACCIA MAPPA GUILD->SESSION
    guildToSession.set(guildId, sessionId);

    const connection: VoiceConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });

    console.log(`🎙️  Connesso al canale: ${channel.name} (Sessione: ${sessionId}, Guild: ${guildId})`);

    connection.receiver.speaking.on('start', (userId: string) => {
        if (isStopping) return; // 🛑 BLOCCO HARDWARE NUOVI STREAM

        // --- CHECK PAUSA ---
        if (pausedGuilds.has(guildId)) {
            return;
        }

        // --- FILTRO BOT ---
        // Recuperiamo l'utente dalla cache del client (se disponibile)
        // Nota: In un contesto reale, 'channel.client' è accessibile.
        const user = channel.client.users.cache.get(userId);
        if (user?.bot) {
            // Ignoriamo completamente lo stream audio dei bot
            return;
        }
        // -----------------

        createListeningStream(connection.receiver, userId, sessionId, guildId);
    });
}

function createListeningStream(receiver: any, userId: string, sessionId: string, guildId: string) {
    const streamKey = `${guildId}-${userId}`;
    const lastError = connectionErrors.get(streamKey) || 0;
    if (Date.now() - lastError < 1000) return;

    if (activeStreams.has(streamKey)) return;

    const opusStream = receiver.subscribe(userId, {
        end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: 10000,
        },
    });

    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const silenceInjector = new SilenceInjector();

    // Cattura timestamp del PRIMO chunk PCM
    let firstChunkTimestamp: number | null = null;
    let isFirstChunk = true;

    const timestampCapture = new Transform({
        transform(chunk, enc, cb) {
            if (isFirstChunk) {
                firstChunkTimestamp = Date.now();
                isFirstChunk = false;
                console.log(`[VoiceRec] 🎯 Primo chunk audio da ${userId} @ ${firstChunkTimestamp}`);
            }
            cb(null, chunk);
        }
    });

    const getNewFile = () => {
        const filename = `${userId}-${Date.now()}.flac`;
        const filepath = path.join(__dirname, '..', 'recordings', filename);

        // Assicuriamoci che la cartella recordings esista
        const recordingsDir = path.dirname(filepath);
        if (!fs.existsSync(recordingsDir)) {
            fs.mkdirSync(recordingsDir, { recursive: true });
        }

        // Nota: non creiamo più il WriteStream qui, lo fa ffmpeg
        return { filepath, filename };
    };

    const { filepath, filename } = getNewFile();

    // Usa spawn invece di prism.FFmpeg per maggiore controllo
    const ffmpeg = spawn('ffmpeg', [
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        '-i', 'pipe:0',
        '-filter:a', 'loudnorm',
        '-c:a', 'flac',
        '-compression_level', '5',
        '-ar', '48000',  // High Quality
        '-ac', '1',      // Mono mixdown is safe here
        '-f', 'flac',
        filepath,
        '-y'
    ]);

    // GESTIONE ERRORI PIPELINE (Prevenzione Crash)
    const handleError = (err: Error, source: string) => {
        if (err.message === 'Premature close') return;

        console.warn(`⚠️ Errore Audio (${source}) per utente ${userId}: ${err.message}`);

        // Se l'errore è critico, chiudiamo lo stream per evitare loop o file corrotti
        if (activeStreams.has(streamKey)) {
            activeStreams.delete(streamKey);
            try { opusStream.destroy(); } catch { }
            try { decoder.destroy(); } catch { }
            try { ffmpeg.stdin?.end(); } catch { }
        }
        connectionErrors.set(streamKey, Date.now());
    };

    decoder.on('error', (e) => handleError(e, 'Decoder'));
    ffmpeg.on('error', (e) => handleError(e, 'FFmpeg'));
    opusStream.on('error', (e: Error) => handleError(e, 'OpusStream'));

    // NUOVA PIPELINE: Opus → Decoder → TimestampCapture → SilenceInjector → FFmpeg
    opusStream
        .pipe(decoder)
        .pipe(timestampCapture)
        .pipe(silenceInjector)
        .pipe(ffmpeg.stdin!);

    activeStreams.set(streamKey, { ffmpeg, decoder, silenceInjector, currentPath: filepath, sessionId });

    console.log(`[Recorder] ⏺️  Registrazione iniziata per utente ${userId} (Guild: ${guildId}): ${filename} (Sessione: ${sessionId})`);

    // ✅ TRACKING: Registra file in elaborazione
    ffmpeg.on('close', async (code) => {
        try {
            if (code === 0 && firstChunkTimestamp) {
                const silenceMs = silenceInjector.getSilenceInjectedMs();
                console.log(`[VoiceRec] ✅ ${filename}: +${silenceMs}ms silenzio iniettato`);

                if (activeStreams.has(streamKey)) {
                    activeStreams.delete(streamKey);
                }

                // Marca come pending per tracking
                if (!pendingFileProcessing.has(guildId)) {
                    pendingFileProcessing.set(guildId, new Set());
                }
                pendingFileProcessing.get(guildId)!.add(filename);

                // USA TIMESTAMP REALE (primo chunk)
                await onFileClosed(userId, filepath, filename, firstChunkTimestamp, sessionId, guildId);

            } else if (!firstChunkTimestamp) {
                console.warn(`[VoiceRec] ⚠️ ${filename}: Nessun chunk audio ricevuto, file vuoto`);
                // Pulizia file vuoto se creato
                if (fs.existsSync(filepath)) {
                    try { fs.unlinkSync(filepath); } catch { }
                }
            } else {
                console.warn(`[VoiceRec] ⚠️ FFmpeg exited with code ${code} for ${filename}`);
            }
        } catch (error) {
            console.error(`[VoiceRec] ❌ Errore in onFileClosed per ${filename}:`, error);
        } finally {
            // 🆕 SEMPRE rimuovi dai pending, anche in caso di errore
            const pending = pendingFileProcessing.get(guildId);
            if (pending) {
                pending.delete(filename);
                if (pending.size === 0) {
                    // 🔥 TRIGGER EVENTO: Sblocca disconnect()
                    const resolvers = fileProcessingResolvers.get(guildId) || [];
                    resolvers.forEach(resolve => resolve());
                    fileProcessingResolvers.delete(guildId);
                }
            }
        }
    });

    opusStream.on('end', async () => {
        // La pipeline chiuderà ffmpeg.stdin automaticamente se pipe è gestita correttamente,
        // ma per sicurezza forziamo la chiusura dello stdin
        if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
            ffmpeg.stdin.end();
        }
    });
}

async function onFileClosed(userId: string, filePath: string, fileName: string, timestamp: number, sessionId: string, guildId: string) {
    // 0. RECUPERA LUOGO E ANNO CORRENTE
    const loc = getCampaignLocation(guildId);
    const macro = loc?.macro || null;
    const micro = loc?.micro || null;

    const campaign = getActiveCampaign(guildId);
    const year = campaign?.current_year ?? null;

    // 1. SALVA SU DB (Stato: PENDING)
    addRecording(sessionId, fileName, filePath, userId, timestamp, macro, micro, year);

    // 2. BACKUP CLOUD (Il "Custode" mette al sicuro l'audio grezzo)
    // Attendiamo l'upload per garantire la sicurezza del file prima di proseguire
    let fileSizeMB = 0;
    try {
        const stats = fs.statSync(filePath);
        fileSizeMB = stats.size / (1024 * 1024);
    } catch (e) { }

    try {
        const uploaded = await uploadToOracle(filePath, fileName, sessionId);
        if (uploaded) {
            updateRecordingStatus(fileName, 'SECURED');
            monitor.logFileUpload(fileSizeMB, fileSizeMB, true); // Assumiamo compressione 1:1 se non sappiamo l'originale
        } else {
            monitor.logFileUpload(fileSizeMB, 0, false);
        }
    } catch (err) {
        console.error(`[Custode] Fallimento upload per ${fileName}:`, err);
        monitor.logFileUpload(fileSizeMB, 0, false);
    }

    // 3. NON ACCODARE TRASCRIZIONE ORA.
    // I file devono rimanere locali e verranno processati (mix + whisper) alla chiusura sessione.

    console.log(`[Recorder] 📥 File ${fileName} salvato e backuppato per la sessione ${sessionId}. In attesa di elaborazione finale.`);
}

export async function disconnect(guildId: string): Promise<boolean> {
    const connection = getVoiceConnection(guildId);
    if (!connection) return false;

    console.log(`[Recorder] 🛑 Disconnessione avviata. Chiusura streams...`);
    isStopping = true; // Attiva il blocco

    // A. Raccogli tutte le promesse di chiusura degli stream attivi
    const closePromises: Promise<void>[] = [];

    for (const [key, stream] of Array.from(activeStreams)) {
        if (key.startsWith(`${guildId}-`)) {
            // Creiamo una Promise che si risolve SOLO quando ffmpeg finisce davvero
            const p = new Promise<void>((resolve) => {
                if (stream.ffmpeg.exitCode !== null) {
                    resolve(); // Già chiuso
                } else {
                    stream.ffmpeg.on('close', () => resolve());
                    stream.ffmpeg.on('error', () => resolve()); // Risolvi anche in caso di errore per non bloccare
                    stream.ffmpeg.stdin?.end(); // Segnale di chiusura gentile
                }
            });
            closePromises.push(p);
            activeStreams.delete(key);
        }
    }

    // B. Aspetta che TUTTI i processi ffmpeg finiscano (senza timeout)
    if (closePromises.length > 0) {
        console.log(`[Recorder] ⏳ Attesa chiusura di ${closePromises.length} stream audio...`);
        await Promise.all(closePromises);
    }

    // C. Aspetta che la logica di "onFileClosed" (DB + Backup) sia finita
    // Sostituito il polling con un'attesa reattiva (Promise)
    const pendingFiles = pendingFileProcessing.get(guildId);
    if (pendingFiles && pendingFiles.size > 0) {
        console.log(`[Recorder] ⏳ Attesa elaborazione finale di ${pendingFiles.size} file...`);

        await new Promise<void>((resolve) => {
            // Registriamo il resolver. Verrà chiamato da ffmpeg.on('close') -> finally
            if (!fileProcessingResolvers.has(guildId)) {
                fileProcessingResolvers.set(guildId, []);
            }
            fileProcessingResolvers.get(guildId)!.push(resolve);
        });

        console.log(`[Recorder] ✅ Tutti i file sono stati processati.`);
    }

    const sessionId = guildToSession.get(guildId);

    // D. FASE FINALE: Mix Audio + Coda Whisper
    if (sessionId) {
        console.log(`[Recorder] 📀 Avvio Mix Sessione e Fase Whisper per ${sessionId}...`);

        try {
            // 1. Session Mixer (Keep files local = true)
            // Stiamo per usarli per Whisper, quindi non cancellarli ancora
            await mixSessionAudio(sessionId, true);

            // 2. Accoda i file per la trascrizione (Whisper)
            // Il worker 'Scriba' gestirà sia la trascrizione che la cancellazione finale dei file
            const recordings = getSessionRecordings(sessionId);

            console.log(`[Recorder] 📥 Accodamento ${recordings.length} file per trascrizione...`);

            for (const rec of recordings) {
                // Solo file ancora pendenti/secured (evita duplicati se crash)
                if (rec.status === 'PENDING' || rec.status === 'SECURED') {
                    await audioQueue.add('transcribe-job', {
                        sessionId: rec.session_id,
                        fileName: rec.filename,
                        filePath: rec.filepath,
                        userId: rec.user_id
                    }, {
                        jobId: rec.filename, // Deduplicazione basata sul nome del file
                        attempts: 5,
                        backoff: { type: 'exponential', delay: 2000 },
                        removeOnComplete: true,
                        removeOnFail: false
                    });
                }
            }
            console.log(`[Recorder] ✅ Fase Whisper avviata per ${sessionId}.`);

        } catch (e: any) {
            console.error(`[Recorder] ❌ Errore nella fase finale Mix/Whisper:`, e);
        }
    }

    guildToSession.delete(guildId);
    pendingFileProcessing.delete(guildId);
    fileProcessingResolvers.delete(guildId);

    try {
        connection.destroy();
    } catch (e) {
        console.warn(`[Recorder] ⚠️ VoiceConnection already destroyed.`);
    }
    isStopping = false; // Reset per la prossima volta
    console.log("👋 Disconnesso in sicurezza.");
    return true;
}

export function isFileActive(fullPath: string): boolean {
    const target = path.resolve(fullPath);
    for (const data of Array.from(activeStreams.values())) {
        if (path.resolve(data.currentPath) === target) return true;
    }
    return false;
}

/**
 * Elimina tutti i file nella cartella recordings locale.
 */
export function wipeLocalFiles() {
    // 1. Pulizia Recordings
    const recordingsDir = path.join(__dirname, '..', 'recordings'); // Fixed path to src/recordings
    if (fs.existsSync(recordingsDir)) {
        try {
            const files = fs.readdirSync(recordingsDir);
            for (const file of files) {
                // Evitiamo di cancellare file nascosti o .gitkeep se presenti
                if (file.startsWith('.')) continue;

                fs.unlinkSync(path.join(recordingsDir, file));
                monitor.logFileDeleted();
            }
            console.log(`[Recorder] 🧹 File locali eliminati (${files.length} file).`);
        } catch (e) {
            console.error("[Recorder] ❌ Errore durante la pulizia dei file locali:", e);
        }
    }
}
