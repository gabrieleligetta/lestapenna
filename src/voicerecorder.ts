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
import { addRecording, updateRecordingStatus } from './db';
import { audioQueue } from './queue';
import { uploadToOracle } from './backupService';

// Struttura per tracciare lo stato completo dello stream
interface ActiveStream {
    out: fs.WriteStream;
    decoder: prism.opus.Decoder;
    encoder: prism.FFmpeg;
    currentPath: string;
    startTime: number;
    sessionId: string;
}

// Mappa aggiornata: UserId -> Dati Stream
const activeStreams = new Map<string, ActiveStream>();
const connectionErrors = new Map<string, number>();

export async function connectToChannel(channel: VoiceBasedChannel, sessionId: string) {
    if (!channel.guild) return;

    const guildId = channel.guild.id;
    const connection: VoiceConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });

    console.log(`🎙️  Connesso al canale: ${channel.name} (Sessione: ${sessionId}, Guild: ${guildId})`);

    connection.receiver.speaking.on('start', (userId: string) => {
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
            duration: 2000,
        },
    });

    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    
    // PIPELINE AGGIORNATA: Aggiunto filtro di normalizzazione audio (loudnorm)
    // Questo aiuta a livellare i volumi tra utenti che urlano e utenti che sussurrano
    const encoder = new prism.FFmpeg({
        args: [
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            '-i', '-',
            '-filter:a', 'loudnorm', // Normalizzazione EBU R128
            '-codec:a', 'libmp3lame',
            '-b:a', '64k',
            '-f', 'mp3',
        ],
    });

    const getNewFile = () => {
        const filename = `${userId}-${Date.now()}.mp3`;
        const filepath = path.join(__dirname, '..', 'recordings', filename);
        
        // Assicuriamoci che la cartella recordings esista
        const recordingsDir = path.dirname(filepath);
        if (!fs.existsSync(recordingsDir)) {
            fs.mkdirSync(recordingsDir, { recursive: true });
        }

        const out = fs.createWriteStream(filepath);
        return { out, filepath, filename };
    };

    const { out, filepath, filename } = getNewFile();
    const startTime = Date.now();

    // PIPELINE: Discord (Opus) -> PCM -> Normalizzazione -> MP3 -> File
    opusStream.pipe(decoder).pipe(encoder).pipe(out);

    activeStreams.set(streamKey, { out, decoder, encoder, currentPath: filepath, startTime, sessionId });

    console.log(`[Recorder] ⏺️  Registrazione iniziata per utente ${userId} (Guild: ${guildId}): ${filename} (Sessione: ${sessionId})`);

    // MODIFICA: Agganciamo il listener subito per gestire anche le chiusure forzate
    out.on('finish', async () => {
        if (activeStreams.has(streamKey)) {
            activeStreams.delete(streamKey);
        }
        await onFileClosed(userId, filepath, filename, startTime, sessionId);
    });

    opusStream.on('end', async () => {
        // La pipeline chiuderà 'out' automaticamente
        // Non serve fare altro qui, il lavoro sporco lo fa out.on('finish')
    });

    opusStream.on('error', (err: Error) => {
        console.error(`Errore stream ${userId} (Guild: ${guildId}):`, err.message);
        activeStreams.delete(streamKey);
        connectionErrors.set(streamKey, Date.now());
    });
}

async function onFileClosed(userId: string, filePath: string, fileName: string, timestamp: number, sessionId: string) {
    // 1. SALVA SU DB (Stato: PENDING)
    addRecording(sessionId, fileName, filePath, userId, timestamp);

    // 2. BACKUP CLOUD (Il "Custode" mette al sicuro l'audio grezzo)
    // Attendiamo l'upload per garantire la sicurezza del file prima di proseguire
    try {
        const uploaded = await uploadToOracle(filePath, fileName, sessionId);
        if (uploaded) {
            updateRecordingStatus(fileName, 'SECURED');
        }
    } catch (err) {
        console.error(`[Custode] Fallimento upload per ${fileName}:`, err);
    }

    // 3. ACCODA (Il job rimarrà in 'waiting' finché non facciamo resume)
    await audioQueue.add('transcribe-job', {
        sessionId: sessionId,
        fileName,
        filePath,
        userId
    }, {
        jobId: fileName, // Deduplicazione basata sul nome del file
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false
    });
    
    console.log(`[Recorder] 📥 File ${fileName} salvato, backup avviato e accodato per la sessione ${sessionId}.`);
}

export async function disconnect(guildId: string): Promise<boolean> {
    const connection = getVoiceConnection(guildId);
    if (connection) {
        console.log(`[Recorder] Disconnessione richiesta per Guild ${guildId}...`);
        
        const closingPromises: Promise<void>[] = [];

        // Chiudiamo manualmente tutti gli stream attivi per questa gilda
        for (const [key, stream] of activeStreams) {
            if (key.startsWith(`${guildId}-`)) {
                console.log(`[Recorder] Chiusura forzata stream ${key}`);
                
                const p = new Promise<void>((resolve) => {
                    // Se lo stream è già chiuso/in chiusura
                    if (stream.out.writableEnded) {
                        resolve();
                        return;
                    }
                    
                    // Attendiamo la fine della scrittura
                    stream.out.once('finish', () => resolve());
                    
                    // Forziamo la chiusura dello stream di scrittura
                    // Questo taglierà la pipeline ma salverà i dati bufferizzati
                    stream.out.end(); 
                });
                
                closingPromises.push(p);
                activeStreams.delete(key); // Rimuoviamo dalla mappa
            }
        }

        if (closingPromises.length > 0) {
            await Promise.all(closingPromises);
            console.log(`[Recorder] ${closingPromises.length} stream chiusi correttamente.`);
        }

        connection.destroy();
        console.log("👋 Disconnesso.");
        return true;
    }
    return false;
}

// Non serve più la rotazione manuale perché usiamo il silenzio naturale per spezzare i file
// e li accumuliamo in coda.
export function isFileActive(fullPath: string): boolean {
    const target = path.resolve(fullPath);
    for (const data of activeStreams.values()) {
        if (path.resolve(data.currentPath) === target) return true;
    }
    return false;
}

/**
 * Elimina tutti i file nella cartella recordings locale.
 */
export function wipeLocalFiles() {
    // 1. Pulizia Recordings
    const recordingsDir = path.join(__dirname, '..', 'recordings');
    if (fs.existsSync(recordingsDir)) {
        try {
            const files = fs.readdirSync(recordingsDir);
            for (const file of files) {
                // Evitiamo di cancellare file nascosti o .gitkeep se presenti
                if (file.startsWith('.')) continue;

                fs.unlinkSync(path.join(recordingsDir, file));
            }
            console.log(`[Recorder] 🧹 File locali eliminati (${files.length} file).`);
        } catch (e) {
            console.error("[Recorder] ❌ Errore durante la pulizia dei file locali:", e);
        }
    }
}
