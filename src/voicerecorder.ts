import {
    joinVoiceChannel,
    EndBehaviorType,
    getVoiceConnection,
    VoiceConnection
} from '@discordjs/voice';
import { VoiceBasedChannel, Client } from 'discord.js';
import * as fs from 'fs';
import * as prism from 'prism-media';
import * as path from 'path';

// Mappa tipizzata: UserId -> Stream di scrittura
const activeStreams = new Map<string, fs.WriteStream>();

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
    if (activeStreams.has(userId)) return;

    // Stream Opus da Discord
    const opusStream = receiver.subscribe(userId, {
        end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: 1000,
        },
    });

    // Decodificatore Opus -> PCM
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

    // Path salvataggio
    const filename = `${userId}-${Date.now()}.pcm`;
    // Risaliamo di due livelli perché siamo in /src (../recordings)
    const filepath = path.join(__dirname, '..', 'recordings', filename);

    const out = fs.createWriteStream(filepath);

    console.log(`⏺️  Inizio registrazione: ${userId}`);

    // PIPELINE: Discord -> Decoder -> File
    opusStream.pipe(decoder).pipe(out);

    activeStreams.set(userId, out);

    opusStream.on('end', () => {
        activeStreams.delete(userId);
    });

    opusStream.on('error', (err: Error) => {
        console.error(`Errore stream ${userId}:`, err.message);
        activeStreams.delete(userId);
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
