import 'dotenv/config'; // Carica .env
import { Client, GatewayIntentBits, Message, VoiceBasedChannel, TextChannel } from 'discord.js';
import { connectToChannel, disconnect } from './voicerecorder';
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { setUserName, getUserName } from './db';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// --- VARIABILI GLOBALI ---
let autoLeaveTimer: NodeJS.Timeout | null = null;
let sessionHeaderSent = false; // TRACCIA SE ABBIAMO GIÀ MANDATO L'INTESTAZIONE

// --- FUNZIONE HELPER PER SPOSTARE FILE (FIX EXDEV) ---
function moveFile(oldPath: string, newPath: string) {
    try {
        // Proviamo il rename veloce
        fs.renameSync(oldPath, newPath);
    } catch (err: any) {
        // Se fallisce perché sono su volumi diversi (EXDEV), facciamo copia+cancella
        if (err.code === 'EXDEV') {
            fs.copyFileSync(oldPath, newPath);
            fs.unlinkSync(oldPath);
        } else {
            throw err;
        }
    }
}

// --- COMANDI ---

client.on('messageCreate', async (message: Message) => {
    if (!message.content.startsWith('!') || message.author.bot) return;

    // FILTRO CANALE COMANDI
    const commandChannelId = process.env.DISCORD_COMMAND_AND_RESPONSE_CHANNEL_ID;
    if (commandChannelId && message.channelId !== commandChannelId) {
        // Se è impostato un canale specifico e il messaggio non arriva da lì, ignoriamo.
        return;
    }

    const args = message.content.slice(1).split(' ');
    const command = args.shift()?.toLowerCase();

    if (!message.guild) return; // Ignora messaggi privati

    // MODIFICA: !join -> !write
    if (command === 'write') {
        const member = message.member;
        if (member?.voice.channel) {
            await connectToChannel(member.voice.channel);
            
            // RESETTO IL FLAG PER LA NUOVA SESSIONE
            sessionHeaderSent = false;
            
            message.reply("🔊 Sono entrato nel canale vocale! Inizio ad ascoltare le vostre gesta.");
            
            // Se il bot entra e non c'è nessuno (improbabile ma possibile), avvia check
            checkAutoLeave(member.voice.channel);
        } else {
            message.reply("Devi essere in un canale vocale per evocare il Bardo!");
        }
    }

    // MODIFICA: !leave -> !stopwriting
    if (command === 'stopwriting') {
        const success = disconnect(message.guild.id);
        if (success) {
            sessionHeaderSent = false; // RESET
            message.reply("🛑 Disconnesso. Sto scrivendo le memorie di questa sessione...");
        }
        else message.reply("Non ero connesso.");
    }

    if (command === 'iam') {
        const characterName = args.join(' ');
        if (characterName) {
            setUserName(message.author.id, characterName);
            message.reply(`⚔️ Benvenuto avventuriero! D'ora in poi sarai conosciuto come **${characterName}**.`);
        } else {
            message.reply("Uso: `!iam Nome Del Tuo PG`");
        }
    }

    if (command === 'whoami') {
        const name = getUserName(message.author.id);
        if (name) {
            message.reply(`Tu sei **${name}**.`);
        } else {
            message.reply("Non so chi sei. Usa `!iam Nome Del Tuo PG` per presentarti.");
        }
    }
});

// --- AUTO LEAVE LOGIC ---

client.on('voiceStateUpdate', (oldState, newState) => {
    // Determina in quale gilda è successo l'evento
    const guild = newState.guild || oldState.guild;
    if (!guild) return;

    // Recupera il bot come membro della gilda
    const botMember = guild.members.cache.get(client.user!.id);
    
    // Se il bot non è connesso a nessun canale vocale in questa gilda, non fare nulla
    if (!botMember?.voice.channel) return;

    // Controlliamo il canale dove si trova il bot
    checkAutoLeave(botMember.voice.channel);
});

function checkAutoLeave(channel: VoiceBasedChannel) {
    // Conta i membri umani (escludendo i bot)
    const humans = channel.members.filter(member => !member.user.bot).size;

    // Se ci sono 0 umani (quindi solo bot), avvia il timer
    if (humans === 0) {
        if (!autoLeaveTimer) {
            console.log("👻 Canale vuoto (solo bot). Avvio timer disconnessione (60s)...");
            autoLeaveTimer = setTimeout(async () => {
                if (channel.guild) {
                    disconnect(channel.guild.id);
                    sessionHeaderSent = false; // RESET
                    console.log("👋 Auto-leave per inattività.");

                    // Notifica nel canale comandi se configurato
                    const commandChannelId = process.env.DISCORD_COMMAND_AND_RESPONSE_CHANNEL_ID;
                    if (commandChannelId) {
                        try {
                            const cmdChannel = await client.channels.fetch(commandChannelId) as TextChannel;
                            if (cmdChannel) {
                                await cmdChannel.send("👻 Nessuno è rimasto ad ascoltare. Il Bardo si ritira nelle sue stanze (Auto-Leave).");
                            }
                        } catch (e) {
                            console.error("Impossibile inviare notifica auto-leave:", e);
                        }
                    }
                }
                autoLeaveTimer = null;
            }, 60000); // 60 secondi
        }
    } else {
        // Se c'è almeno un umano, annulla il timer
        if (autoLeaveTimer) {
            console.log("👥 Umani rilevati. Timer auto-leave annullato.");
            clearTimeout(autoLeaveTimer);
            autoLeaveTimer = null;
        }
    }
}

// --- TIMER 10 MINUTI (WORKER) ---
// Default 1 minuto se non specificato, altrimenti usa il valore env
const intervalMinutes = parseInt(process.env.SUMMARY_INTERVAL_MINUTES || '1');
const WORKER_INTERVAL = intervalMinutes * 60 * 1000;
let isWorkerRunning = false;

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

    if (!fs.existsSync(recFolder)) fs.mkdirSync(recFolder);
    if (!fs.existsSync(batchFolder)) fs.mkdirSync(batchFolder);

    const files = fs.readdirSync(recFolder).filter(f => f.endsWith('.pcm'));
    
    if (files.length === 0) return;

    console.log(`📦 Sposto ${files.length} file nel batch processor...`);

    files.forEach(file => {
        const oldPath = path.join(recFolder, file);
        const newPath = path.join(batchFolder, file);
        try {
            // FIX EXDEV: Usiamo la nostra funzione sicura
            moveFile(oldPath, newPath);
        } catch (err: any) {
            console.error(`Errore spostamento ${file}:`, err.message);
        }
    });

    isWorkerRunning = true;

    const extension = __filename.endsWith('.ts') ? 'ts' : 'js';
    const workerPath = path.join(__dirname, `worker.${extension}`);
    
    console.log(`[Main] Lancio worker da: ${workerPath}`);

    const worker = new Worker(workerPath, { 
        workerData: { batchFolder },
        // FIX WORKER: Se il file è .ts, diciamo al worker di usare ts-node per capire il codice
        execArgv: extension === 'ts' ? ['-r', 'ts-node/register'] : undefined
    });

    worker.on('message', async (result) => {
        if (result.status === 'success') {
            console.log("✅ [Main] Worker completato!");
            
            try {
                const channelId = process.env.DISCORD_SUMMARY_CHANNEL_ID;
                if (!channelId) {
                    console.error("❌ Manca DISCORD_SUMMARY_CHANNEL_ID nel file .env");
                    return;
                }

                const channel = await client.channels.fetch(channelId) as TextChannel;
                
                if (channel) {
                    let messageContent = "";

                    // LOGICA INTESTAZIONE
                    if (!sessionHeaderSent) {
                        const today = new Date();
                        const dateStr = today.toLocaleDateString('it-IT', {
                            weekday: 'long', 
                            year: 'numeric', 
                            month: 'long', 
                            day: 'numeric' 
                        });
                        // Prima volta: Intestazione Rossa
                        messageContent = `\`\`\`diff\n-SESSIONE DEL ${dateStr.toUpperCase()}\n\`\`\`\n${result.summary}`;
                        sessionHeaderSent = true;
                    } else {
                        // Volte successive: Solo separatore discreto
                        messageContent = `**...continua:**\n${result.summary}`;
                    }

                    await channel.send(messageContent);
                    
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
        isWorkerRunning = false;
    });

    worker.on('exit', (code) => {
        isWorkerRunning = false;
        if (code !== 0) console.error(`[Main] Worker fermato con codice ${code}`);
    });
}

client.once('ready', () => {
    console.log(`🤖 Bot TS online: ${client.user?.tag}`);
});

client.login(process.env.DISCORD_BOT_TOKEN);
