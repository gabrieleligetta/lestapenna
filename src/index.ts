import 'dotenv/config'; // Carica .env
import { Client, GatewayIntentBits, Message, VoiceBasedChannel, TextChannel } from 'discord.js';
import { connectToChannel, disconnect } from './voicerecorder';
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// --- COMANDI ---

client.on('messageCreate', async (message: Message) => {
    if (!message.content.startsWith('!') || message.author.bot) return;

    const args = message.content.slice(1).split(' ');
    const command = args.shift()?.toLowerCase();

    if (!message.guild) return; // Ignora messaggi privati

    if (command === 'join') {
        // TypeScript vuole essere sicuro che 'voice' esista su 'member'
        const member = message.member;
        if (member?.voice.channel) {
            await connectToChannel(member.voice.channel);
            message.reply("👂 Sto registrando...");
        } else {
            message.reply("Devi essere in un canale vocale!");
        }
    }

    if (command === 'leave') {
        const success = disconnect(message.guild.id);
        if (success) message.reply("🛑 Registrazione fermata.");
        else message.reply("Non ero connesso.");
    }
});

// --- TIMER 10 MINUTI ---
const WORKER_INTERVAL = 10 * 60 * 1000;

setInterval(() => {
    console.log("⏰ Check Worker...");
    runBatchProcessor();
}, WORKER_INTERVAL);

function runBatchProcessor() {
    const recFolder = path.join(__dirname, '..', 'recordings');
    const batchFolder = path.join(__dirname, '..', 'batch_processing');

    // Assicuriamoci che le cartelle esistano
    if (!fs.existsSync(recFolder)) fs.mkdirSync(recFolder);
    if (!fs.existsSync(batchFolder)) fs.mkdirSync(batchFolder);

    // Spostiamo i file (Move atomico)
    const files = fs.readdirSync(recFolder).filter(f => f.endsWith('.pcm'));
    
    if (files.length === 0) return;

    console.log(`📦 Sposto ${files.length} file nel batch processor...`);

    files.forEach(file => {
        const oldPath = path.join(recFolder, file);
        const newPath = path.join(batchFolder, file);
        try {
            fs.renameSync(oldPath, newPath);
        } catch (err: any) {
            console.error(`Errore spostamento ${file}:`, err.message);
        }
    });

    // --- AVVIO DEL WORKER ---
    // Se siamo in esecuzione TS (ts-node) cerchiamo .ts, altrimenti .js
    const extension = __filename.endsWith('.ts') ? 'ts' : 'js';
    const workerPath = path.join(__dirname, `worker.${extension}`);
    
    // Debug per essere sicuri
    console.log(`[Main] Lancio worker da: ${workerPath}`);

    const worker = new Worker(workerPath, { 
        workerData: { batchFolder }
    });

    worker.on('message', async (result) => {
        if (result.status === 'success') {
            console.log("✅ [Main] Worker completato!");
            
            // --- LOGICA DI INVIO DISCORD ---
            try {
                const channelId = process.env.DISCORD_SUMMARY_CHANNEL_ID;
                if (!channelId) {
                    console.error("❌ Manca DISCORD_SUMMARY_CHANNEL_ID nel file .env");
                    return;
                }

                // Recuperiamo il canale
                const channel = await client.channels.fetch(channelId) as TextChannel;
                
                if (channel) {
                    // 1. Otteniamo la data formattata (DD/MM/YYYY)
                    const today = new Date();
                    const dateStr = today.toLocaleDateString('it-IT', {
                        day: '2-digit', month: '2-digit', year: 'numeric'
                    });
                    
                    // 2. Formattazione stile screenshot (Red Text / Diff)
                    // Il trattino '-' all'inizio della riga in ```diff lo rende rosso.
                    const header = `\`\`\`diff\n-SESSIONE DEL ${dateStr}\n\`\`\``;

                    // 3. Invio del messaggio
                    // Mettiamo il riassunto sotto l'header
                    await channel.send(`${header}\n${result.summary}`);
                    
                    console.log("📨 Riassunto inviato al canale Discord!");
                } else {
                    console.error("❌ Canale non trovato o il bot non ha accesso.");
                }
            } catch (err) {
                console.error("❌ Errore nell'invio del messaggio:", err);
            }
        }
    });

    worker.on('error', (err) => {
        console.error("❌ [Main] Errore nel Worker:", err);
    });

    worker.on('exit', (code) => {
        if (code !== 0) console.error(`[Main] Worker fermato con codice ${code}`);
    });
}

client.once('ready', () => {
    console.log(`🤖 Bot TS online: ${client.user?.tag}`);
});

client.login(process.env.DISCORD_BOT_TOKEN);
