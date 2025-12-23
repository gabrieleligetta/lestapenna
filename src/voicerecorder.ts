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

// Struttura per tracciare lo stato completo dello stream
interface ActiveStream {
    out: fs.WriteStream;
    decoder: prism.opus.Decoder;
    currentPath: string;
}

// Mappa aggiornata: UserId -> Dati Stream
const activeStreams = new Map<string, ActiveStream>();

// Mappa per tracciare gli errori di connessione per il debounce
const connectionErrors = new Map<string, number>();

export async function connectToChannel(channel: VoiceBasedChannel) {
    if (!channel.guild) return;

    const connection: VoiceConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });

    console.log(`🎙️  Connesso al canale: ${channel.name}`);

    // Listener per quando qualcuno parla
    connection.receiver.speaking.on('start', (userId: string) => {
        createListeningStream(connection.receiver, userId);
    });
}

function createListeningStream(receiver: any, userId: string) {
    // 1. DEBOUNCE: Se questo utente ha dato errore meno di 1 secondo fa, ignoriamo
    const lastError = connectionErrors.get(userId) || 0;
    if (Date.now() - lastError < 1000) {
        return; 
    }

    // Se c'è già uno stream attivo per questo utente, non ne creiamo un altro
    if (activeStreams.has(userId)) return;

    // Stream Opus da Discord
    const opusStream = receiver.subscribe(userId, {
        end: {
            behavior: EndBehaviorType.AfterSilence,
            // AUMENTIAMO il timeout: Il file resta aperto finché l'utente parla
            // o finché non lo tagliamo noi con la rotazione.
            // Mettiamo un valore alto (es. 5 minuti) per sicurezza,
            // ma ci penserà il "rotateAllStreams" a tagliare ogni minuto.
            duration: 60 * 5 * 1000, 
        },
    });

    // Decodificatore Opus -> PCM
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

    // Funzione helper per creare il file
    const getNewFile = () => {
        const filename = `${userId}-${Date.now()}.pcm`;
        const filepath = path.join(__dirname, '..', 'recordings', filename);
        const out = fs.createWriteStream(filepath);
        return { out, filepath };
    };

    const { out, filepath } = getNewFile();

    console.log(`⏺️  Inizio registrazione (nuovo segmento): ${userId}`);

    // PIPELINE: Discord -> Decoder -> File
    opusStream.pipe(decoder).pipe(out);

    // Salviamo tutto il necessario per poter "tagliare" lo stream dopo
    activeStreams.set(userId, { out, decoder, currentPath: filepath });

    opusStream.on('end', () => {
        activeStreams.delete(userId);
    });

    opusStream.on('error', (err: Error) => {
        console.error(`Errore stream ${userId}:`, err.message);
        activeStreams.delete(userId);

        // 2. REGISTRA L'ERRORE per attivare il freno
        connectionErrors.set(userId, Date.now());
    });
}

export function disconnect(guildId: string): boolean {
    const connection = getVoiceConnection(guildId);
    if (connection) {
        connection.destroy();
        console.log("👋 Disconnesso.");
        return true;
    }
    return false;
}

// --- NUOVE FUNZIONI PER GESTIRE LA ROTAZIONE ---

// 1. Taglia tutti i file aperti, li chiude e ne apre di nuovi (senza perdere audio)
export function rotateAllStreams() {
    if (activeStreams.size === 0) return;

    console.log("🔄 Ruoto i file audio attivi (taglio per invio al worker)...");

    activeStreams.forEach((data, userId) => {
        const { out, decoder, currentPath } = data;
        
        // A. Stacca il vecchio file (unpipe) e chiudilo
        decoder.unpipe(out);
        out.end();
        
        // B. Crea nuovo file con nuovo timestamp
        const newFilename = `${userId}-${Date.now()}.pcm`;
        const newFilepath = path.join(__dirname, '..', 'recordings', newFilename);
        const newOut = fs.createWriteStream(newFilepath);

        // C. Attacca il nuovo file al decoder esistente
        decoder.pipe(newOut);

        // D. Aggiorna la mappa con i nuovi riferimenti
        data.out = newOut;
        data.currentPath = newFilepath;
    });
}

// 2. Controlla se un file è attualmente in scrittura (per non spostarlo)
export function isFileActive(fullPath: string): boolean {
    const target = path.resolve(fullPath);
    for (const data of activeStreams.values()) {
        if (path.resolve(data.currentPath) === target) return true;
    }
    return false;
}
