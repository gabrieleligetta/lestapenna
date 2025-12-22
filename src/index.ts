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

// --- GESTIONE NOMI PG ---
const mapPath = path.join(__dirname, '..', 'character_map.json');
let characterMap: Record<string, string> = {};

// Carica mappa all'avvio
if (fs.existsSync(mapPath)) {
    try {
        characterMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    } catch (e) {
        console.error("Errore lettura character_map.json", e);
    }
}

function saveCharacterMap() {
    fs.writeFileSync(mapPath, JSON.stringify(characterMap, null, 2));
}

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

    if (command === 'iam') {
        const characterName = args.join(' ');
        if (characterName) {
            characterMap[message.author.id] = characterName;
            saveCharacterMap();
            message.reply(`✅ Ok, da ora sei **${characterName}**.`);
        } else {
            message.reply("Uso: `!iam Nome Del Tuo PG`");
        }
    }
});

// --- TIMER 10 MINUTI ---
const WORKER_INTERVAL = 10 * 60 * 1000;
let isWorkerRunning = false; // SEMAFORO PER LA CONCORRENZA

setInterval(() => {
    console.log("⏰ Check Worker...");
    if (isWorkerRunning) {
        console.log("⚠️ Worker precedente ancora in esecuzione. Salto questo turno.");
        return;
    }
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
    isWorkerRunning = true; // BLOCCO IL SEMAFORO

    // Se siamo in esecuzione TS (ts-node) cerchiamo .ts, altrimenti .js
    const extension = __filename.endsWith('.ts') ? 'ts' : 'js';
    const workerPath = path.join(__dirname, `worker.${extension}`);
    
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
                    const today = new Date();
                    const dateStr = today.toLocaleDateString('it-IT', {
                        day: '2-digit', month: '2-digit', year: 'numeric'
                    });
                    
                    const header = `\`\`\`diff\n-SESSIONE DEL ${dateStr}\n\`\`\``;
                    await channel.send(`${header}\n${result.summary}`);
                    
                    console.log("📨 Riassunto inviato al canale Discord!");
                } else {
                    console.error("❌ Canale non trovato o il bot non ha accesso.");
                }
            } catch (err) {
                console.error("❌ Errore nell'invio del messaggio:", err);
            }
        } else if (result.status === 'skipped') {
            console.log(`ℹ️ [Main] Worker skipped: ${result.message}`);
        }
    });

    worker.on('error', (err) => {
        console.error("❌ [Main] Errore nel Worker:", err);
        isWorkerRunning = false; // SBLOCCO IN CASO DI ERRORE
    });

    worker.on('exit', (code) => {
        isWorkerRunning = false; // SBLOCCO ALLA FINE
        if (code !== 0) console.error(`[Main] Worker fermato con codice ${code}`);
    });
}

client.once('ready', () => {
    console.log(`🤖 Bot TS online: ${client.user?.tag}`);
});

client.login(process.env.DISCORD_BOT_TOKEN);
