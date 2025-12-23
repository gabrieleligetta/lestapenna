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
}

// Mappa aggiornata: UserId -> Dati Stream
const activeStreams = new Map<string, ActiveStream>();
const connectionErrors = new Map<string, number>();

// ID Sessione corrente (impostato dal bot)
let currentSessionId: string | null = null;

export async function connectToChannel(channel: VoiceBasedChannel, sessionId: string) {
    if (!channel.guild) return;

    currentSessionId = sessionId; // Salviamo l'ID sessione

    const connection: VoiceConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });

    console.log(`🎙️  Connesso al canale: ${channel.name} (Sessione: ${sessionId})`);

    connection.receiver.speaking.on('start', (userId: string) => {
        createListeningStream(connection.receiver, userId);
    });
}

function createListeningStream(receiver: any, userId: string) {
    const lastError = connectionErrors.get(userId) || 0;
    if (Date.now() - lastError < 1000) return; 

    if (activeStreams.has(userId)) return;

    const opusStream = receiver.subscribe(userId, {
        end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: 1000, // Chiudiamo dopo 1 secondo di silenzio (più reattivo ora che accumuliamo)
        },
    });

    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const encoder = new prism.FFmpeg({
        args: [
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            '-i', '-',
            '-codec:a', 'libmp3lame',
            '-b:a', '64k',
            '-f', 'mp3',
        ],
    });

    const getNewFile = () => {
        const filename = `${userId}-${Date.now()}.mp3`;
        const filepath = path.join(__dirname, '..', 'recordings', filename);
        const out = fs.createWriteStream(filepath);
        return { out, filepath, filename };
    };

    const { out, filepath, filename } = getNewFile();
    const startTime = Date.now();

    // PIPELINE: Discord (Opus) -> PCM -> MP3 -> File
    opusStream.pipe(decoder).pipe(encoder).pipe(out);

    activeStreams.set(userId, { out, decoder, encoder, currentPath: filepath, startTime });

    console.log(`[Recorder] ⏺️  Registrazione iniziata per utente ${userId}: ${filename}`);

    opusStream.on('end', async () => {
        activeStreams.delete(userId);
        
        // Quando il file è chiuso (la pipeline finisce), procediamo con il backup e l'accodamento
        out.on('finish', async () => {
            if (currentSessionId) {
                await onFileClosed(userId, filepath, filename, startTime);
            }
        });
    });

    opusStream.on('error', (err: Error) => {
        console.error(`Errore stream ${userId}:`, err.message);
        activeStreams.delete(userId);
        connectionErrors.set(userId, Date.now());
    });
}

async function onFileClosed(userId: string, filePath: string, fileName: string, timestamp: number) {
    if (!currentSessionId) return;

    // 1. SALVA SU DB (Stato: PENDING)
    addRecording(currentSessionId, fileName, filePath, userId, timestamp);

    // 2. BACKUP CLOUD (Il "Custode" mette al sicuro l'audio grezzo)
    // Attendiamo l'upload per garantire la sicurezza del file prima di proseguire
    try {
        const uploaded = await uploadToOracle(filePath, fileName, currentSessionId);
        if (uploaded) {
            updateRecordingStatus(fileName, 'SECURED');
        }
    } catch (err) {
        console.error(`[Custode] Fallimento upload per ${fileName}:`, err);
    }

    // 3. ACCODA (Il job rimarrà in 'waiting' finché non facciamo resume)
    await audioQueue.add('transcribe-job', {
        sessionId: currentSessionId,
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
    
    console.log(`[Recorder] 📥 File ${fileName} salvato, backup avviato e accodato per la sessione ${currentSessionId}.`);
}

export function disconnect(guildId: string): boolean {
    const connection = getVoiceConnection(guildId);
    if (connection) {
        connection.destroy();
        currentSessionId = null; // Reset sessione
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
