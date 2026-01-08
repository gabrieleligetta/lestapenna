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
import { EventEmitter } from 'events';
import { addRecording, updateRecordingStatus, getCampaignLocation, getActiveCampaign, createSession, getSessionStartTime } from './db';
import { audioQueue } from './queue';
import { uploadToOracle } from './backupService';
import { mixSessionAudio } from './sessionMixer';

const execAsync = promisify(exec);

// --- RTP PACKET MONITOR ---
// Intercetta i pacchetti UDP grezzi per estrarre i timestamp RTP reali
interface RtpPacketInfo {
    timestamp: number;
    sequence: number;
    size: number;
}

class PacketMonitor extends EventEmitter {
    private socket: any;
    private cleanupFn: (() => void) | undefined;

    constructor(connection: VoiceConnection) {
        super();
        this.attach(connection);
    }

    private attach(connection: VoiceConnection) {
        try {
            const networking = (connection as any).networking;
            const udp = networking?.state?.udp;
            const socket = udp?.socket;

            if (socket) {
                this.socket = socket;
                const listener = (msg: Buffer) => this.parsePacket(msg);
                socket.on('message', listener);
                this.cleanupFn = () => socket.off('message', listener);
                console.log(`[PacketMonitor] 📡 Monitor UDP agganciato.`);
            } else {
                console.warn(`[PacketMonitor] ⚠️ Impossibile trovare il socket UDP.`);
            }
        } catch (e) {
            console.error(`[PacketMonitor] ❌ Errore attach:`, e);
        }
    }

    private parsePacket(buffer: Buffer) {
        if (buffer.length < 12) return;

        const firstByte = buffer[0];
        const version = (firstByte >> 6) & 0x03;
        if (version !== 2) return;

        const extension = (firstByte >> 4) & 0x01;
        const csrcCount = firstByte & 0x0F;

        const sequence = buffer.readUInt16BE(2);
        const timestamp = buffer.readUInt32BE(4);
        const ssrc = buffer.readUInt32BE(8);

        let offset = 12 + (csrcCount * 4);

        if (extension) {
            if (offset + 4 > buffer.length) return;
            const extLen = buffer.readUInt16BE(offset + 2);
            offset += 4 + (extLen * 4);
        }

        // Calcoliamo la dimensione del payload decriptato stimata
        // Sottraiamo 16 bytes (Poly1305 MAC) che sono parte del pacchetto criptato
        const payloadSize = buffer.length - offset - 16;

        if (payloadSize > 0) {
            this.emit('packet', ssrc, { timestamp, sequence, size: payloadSize });
        }
    }

    public destroy() {
        if (this.cleanupFn) this.cleanupFn();
        this.removeAllListeners();
    }
}

const guildMonitors = new Map<string, PacketMonitor>();

function ensurePacketMonitor(guildId: string, connection: VoiceConnection) {
    if (!guildMonitors.has(guildId)) {
        guildMonitors.set(guildId, new PacketMonitor(connection));
    }
    return guildMonitors.get(guildId)!;
}

// --- RTP SILENCE INJECTOR ---
// Usa i timestamp RTP reali per calcolare il silenzio, garantendo coerenza temporale

// COSTANTI CONFIGURAZIONE
// 12 Ore: Qualsiasi silenzio inferiore a questo viene RIEMPITO per mantenere la sync.
// Questo copre: pause pranzo, giocatori silenziosi, monologhi del DM.
const MAX_SESSION_SILENCE_MS = 12 * 60 * 60 * 1000; 

// Frame Opus di silenzio standard
const SILENCE_FRAME = Buffer.from([0xF8, 0xFF, 0xFE]); 

// Ottimizzazione: Buffer pre-calcolato di 1 minuto di silenzio per ridurre i cicli CPU
// 1 min = 3000 frames da 20ms
const ONE_MIN_SILENCE_BUFFER = Buffer.alloc(3000 * SILENCE_FRAME.length);
for (let i = 0; i < 3000; i++) {
    SILENCE_FRAME.copy(ONE_MIN_SILENCE_BUFFER, i * SILENCE_FRAME.length);
}

class RtpSilenceInjector extends Transform {
    public lastPacketTime: number = Date.now(); // Per timeout inattività
    private lastTimestamp: number | null = null;
    private packetQueue: RtpPacketInfo[] = [];
    private _ssrc: number;
    private monitor: PacketMonitor;

    constructor(ssrc: number, monitor: PacketMonitor) {
        super();
        this._ssrc = ssrc;
        this.monitor = monitor;
        
        // Ascolta i pacchetti UDP per questo SSRC
        this.monitor.on('packet', (packetSsrc, info) => {
            if (packetSsrc === this._ssrc) {
                this.packetQueue.push(info);
                // Limite coda per evitare memory leak in caso di packet loss massiccio
                if (this.packetQueue.length > 50) {
                    this.packetQueue.shift(); 
                }
            }
        });
    }

    public get ssrc(): number {
        return this._ssrc;
    }

    public setSsrc(newSsrc: number) {
        this._ssrc = newSsrc;
        this.lastTimestamp = null; // Reset fondamentale per evitare delta enormi al cambio
        this.packetQueue = [];
    }

    _transform(chunk: Buffer, _encoding: string, callback: Function) {
        this.lastPacketTime = Date.now();

        // Cerchiamo il pacchetto RTP corrispondente nella coda basandoci sulla dimensione
        // Questo è un'euristica necessaria perché non abbiamo il Sequence Number nel chunk decriptato
        const matchIndex = this.packetQueue.findIndex(p => Math.abs(p.size - chunk.length) <= 1);

        if (matchIndex !== -1) {
            // Trovato!
            const info = this.packetQueue[matchIndex];
            
            // Rimuoviamo questo pacchetto e tutti i precedenti (che assumiamo persi/droppati)
            this.packetQueue.splice(0, matchIndex + 1);

            if (this.lastTimestamp !== null) {
                let delta = info.timestamp - this.lastTimestamp;

                // 1. FIX ROLLOVER (Bug matematico 32-bit)
                if (delta < -2147483648) delta += 4294967296;

                // 2. FIX JITTER (Pacchetti vecchi)
                if (delta < 0) {
                    callback(); 
                    return; 
                }

                // 3. GESTIONE BUCHI (SILENCE FILLING)
                if (delta > 960) {
                    const missingFrames = Math.floor(delta / 960) - 1;
                    const missingMs = missingFrames * 20;

                    if (missingFrames > 0) {
                        // CASO A: Silenzio "Umano" (fino a 12 ore) -> RIEMPIAMO
                        if (missingMs <= MAX_SESSION_SILENCE_MS) {
                            
                            // OTTIMIZZAZIONE PER LUNGHI SILENZI
                            // Invece di fare un loop di 100.000 push piccoli, usiamo blocchi da 1 minuto
                            
                            let remainingFrames = missingFrames;
                            
                            // 1. Spingi blocchi interi da 1 minuto (molto veloce)
                            while (remainingFrames >= 3000) {
                                this.push(ONE_MIN_SILENCE_BUFFER);
                                remainingFrames -= 3000;
                            }

                            // 2. Spingi il resto (se c'è)
                            if (remainingFrames > 0) {
                                const remainingBuffer = Buffer.alloc(remainingFrames * SILENCE_FRAME.length);
                                for (let i = 0; i < remainingFrames; i++) {
                                    SILENCE_FRAME.copy(remainingBuffer, i * SILENCE_FRAME.length);
                                }
                                this.push(remainingBuffer);
                            }
                            
                        } 
                        // CASO B: Buco impossibile (> 12 ore) -> BUG TIMESTAMP
                        else {
                            console.warn(`[Audio] ⚠️ Salto temporale di ${missingMs/1000/60} min rilevato (Bug Timestamp o Disconnessione Bot). Eseguo Soft Reset.`);
                            // Qui resettiamo perché 12+ ore di silenzio non servono a nessuno 
                            // e probabilmente indicano che il bot è stato offline o c'è un bug.
                            this.lastTimestamp = null;
                        }
                    }
                }
            }
            this.lastTimestamp = info.timestamp;
        } else {
            // Fallback: se non troviamo corrispondenza (raro), passiamo il chunk e basta.
            // Potremmo usare Date.now() qui, ma rischieremmo di reintrodurre il jitter.
            // Meglio non fare nulla e sperare nel prossimo allineamento.
        }

        this.push(chunk);
        callback();
    }

    _destroy(error: Error | null, callback: (error?: Error | null) => void) {
        // Cleanup listener is handled by PacketMonitor being global/shared, 
        // but we should probably remove our specific listener if we used a specific one.
        // Since we used monitor.on which is an EventEmitter, we can't easily remove just our lambda 
        // unless we stored the reference. 
        // Given the architecture, we rely on GC or maxListeners. 
        // For better practice, let's store the listener.
        super._destroy(error, callback);
    }
}

// Strutture Dati
interface ActiveStream {
    out: fs.WriteStream;
    decoder: prism.opus.Decoder;
    encoder: prism.FFmpeg;
    silenceInjector: RtpSilenceInjector;
    opusStream: any;
    currentPath: string;
    connectionStartTime: number; // Tempo inizio connessione utente (per calcolo delay)
    sessionId: string;
    rotationTimer?: NodeJS.Timeout;
    chunks: string[]; // Lista dei file parziali generati
}

const activeStreams = new Map<string, ActiveStream>();
const connectionErrors = new Map<string, number>();
const pausedGuilds = new Set<string>();

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

    console.log(`🎙️  Connesso al canale: ${channel.name} (Sessione: ${sessionId}, Guild: ${guildId})`);

    // Setup Monitor UDP
    ensurePacketMonitor(guildId, connection);

    connection.receiver.speaking.on('start', (userId: string) => {
        if (pausedGuilds.has(guildId)) return;
        const user = channel.client.users.cache.get(userId);
        if (user?.bot) return; 
        
        const streamKey = `${guildId}-${userId}`;
        
        // Controlliamo se esiste già uno stream attivo
        const existingStream = activeStreams.get(streamKey);

        if (existingStream) {
            // Recupera il nuovo SSRC segnalato da Discord
            const newSsrc = (connection.receiver.speaking as any).users.get(userId);
            
            // Se c'è uno stream MA l'SSRC è diverso, aggiorniamo l'iniettore
            if (newSsrc && existingStream.silenceInjector.ssrc !== newSsrc) {
                console.log(`[Recorder] 🔄 Cambio SSRC per ${userId}: ${existingStream.silenceInjector.ssrc} -> ${newSsrc}`);
                existingStream.silenceInjector.setSsrc(newSsrc);
            }
            return; // Stream già esistente e aggiornato, usciamo
        }

        createListeningStream(connection, userId, sessionId, guildId);
    });
}

function createListeningStream(connection: VoiceConnection, userId: string, sessionId: string, guildId: string) {
    const streamKey = `${guildId}-${userId}`;
    if (activeStreams.has(streamKey)) return;

    const lastError = connectionErrors.get(streamKey) || 0;
    if (Date.now() - lastError < 1000) return; 

    console.log(`[Recorder] 🆕 Creazione nuovo stream persistente per ${userId}`);

    const receiver = connection.receiver;
    const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.Manual },
    });

    // Recupera SSRC
    const ssrc = (receiver.speaking as any).users.get(userId);
    if (!ssrc) {
        console.warn(`[Recorder] ⚠️ SSRC non trovato per ${userId}, impossibile sincronizzare.`);
        // Potremmo abortire o riprovare, ma per ora proseguiamo (il monitor non riceverà pacchetti)
    }

    const monitor = ensurePacketMonitor(guildId, connection);
    const silenceInjector = new RtpSilenceInjector(ssrc, monitor);
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
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

    // PIPELINE MODIFICATA: Opus -> Injector -> Decoder -> Encoder -> File
    opusStream.pipe(silenceInjector).pipe(decoder).pipe(encoder).pipe(out);

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

        // Stacchiamo il decoder dall'encoder vecchio
        streamData.decoder.unpipe(oldEncoder);
        
        oldEncoder.end();
        oldOut.on('finish', () => {
             saveChunkBackup(oldPath, oldName, sessionId).catch(console.error);
        });

        const newFile = getNewFile();
        const newEncoder = createEncoder();

        streamData.out = newFile.out;
        streamData.encoder = newEncoder;
        streamData.currentPath = newFile.filepath;
        streamData.chunks.push(newFile.filename);

        newEncoder.on('error', (e) => handleError(e, 'Encoder-Rotated'));
        streamData.out.on('error', (e) => handleError(e, 'FileWrite-Rotated'));

        // Ricolleghiamo il decoder al nuovo encoder
        streamData.decoder.pipe(newEncoder).pipe(streamData.out);

    }, CHUNK_DURATION_MS);

    activeStreams.set(streamKey, { 
        out, decoder, encoder, silenceInjector, opusStream,
        currentPath: filepath, connectionStartTime, sessionId, rotationTimer,
        chunks: [filename]
    });

    console.log(`[Recorder] ⏺️  Registrazione CONTINUA avviata per ${userId} (Chunk: 5min)`);
}

export async function closeUserStream(guildId: string, userId: string) {
    const streamKey = `${guildId}-${userId}`;
    if (activeStreams.has(streamKey)) {
        console.log(`[Recorder] ♻️ Utente ${userId} uscito/riconnesso: chiusura stream forzata.`);
        await closeStream(streamKey);
    }
}

async function closeStream(streamKey: string) {
    const stream = activeStreams.get(streamKey);
    if (!stream) return;

    console.log(`[Recorder] 🛑 Chiusura stream ${streamKey}`);

    if (stream.rotationTimer) clearInterval(stream.rotationTimer);

    try { stream.opusStream.destroy(); } catch {}
    try { stream.silenceInjector.destroy(); } catch {}
    try { stream.decoder.destroy(); } catch {}
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

        // Processa il file (DB, Upload, Trascrizione)
        await processFinalFile(userId, outputPath, outputFilename, sessionId, guildId, startTime);

        // Pulizia Chunk Locali
        for (const chunk of validChunks) {
            try { fs.unlinkSync(path.join(recordingsDir, chunk)); } catch {}
        }

    } catch (error) {
        console.error(`[Recorder] ❌ Errore Merge/Normalizzazione FFmpeg:`, error);
    }
}

async function processFinalFile(userId: string, filePath: string, fileName: string, sessionId: string, guildId: string, startTime: number) {
    const loc = getCampaignLocation(guildId);
    const campaign = getActiveCampaign(guildId);
    // const timestamp = Date.now(); // RIMOSSO: Usiamo startTime passato come argomento

    addRecording(sessionId, fileName, filePath, userId, startTime, loc?.macro, loc?.micro, campaign?.current_year);

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

export async function disconnect(guildId: string): Promise<boolean> {
    const connection = getVoiceConnection(guildId);
    if (connection) {
        console.log(`[Recorder] Disconnessione richiesta per Guild ${guildId}...`);
        
        // Cleanup Monitor
        const monitor = guildMonitors.get(guildId);
        if (monitor) {
            monitor.destroy();
            guildMonitors.delete(guildId);
        }

        // Identifica sessione
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

        // Attendi un attimo per sicurezza
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Genera Master Mix
        if (sessionId) {
            try {
                const masterPath = await mixSessionAudio(sessionId);
                const outputFilename = path.basename(masterPath);
                const customKey = `recordings/${sessionId}/master/${outputFilename}`;
                await uploadToOracle(masterPath, outputFilename, sessionId, customKey);
                console.log(`[Recorder] 🎹 Master Mix caricato su Oracle: ${outputFilename}`);
            } catch (e) {
                console.error(`[Recorder] ❌ Errore creazione/upload Master Mix:`, e);
            }
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
