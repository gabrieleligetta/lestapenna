import 'dotenv/config';
import { Client, GatewayIntentBits, Message, VoiceBasedChannel, TextChannel } from 'discord.js';
import { connectToChannel, disconnect } from './voicerecorder';
import { audioQueue } from './queue';
import { generateSummary, TONES, ToneKey } from './bard';
import { getAvailableSessions, updateUserField, getUserProfile } from './db';
import { v4 as uuidv4 } from 'uuid';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

let currentSessionId: string | null = null;
let autoLeaveTimer: NodeJS.Timeout | null = null;

client.on('messageCreate', async (message: Message) => {
    if (!message.content.startsWith('!') || message.author.bot) return;

    const commandChannelId = process.env.DISCORD_COMMAND_AND_RESPONSE_CHANNEL_ID;
    if (commandChannelId && message.channelId !== commandChannelId) return;

    const args = message.content.slice(1).split(' ');
    const command = args.shift()?.toLowerCase();

    if (!message.guild) return;

    // --- COMANDO LISTEN (INIZIO SESSIONE) ---
    if (command === 'listen') {
        const member = message.member;
        if (member?.voice.channel) {
            currentSessionId = uuidv4();
            await audioQueue.pause();
            console.log(`[Flow] Coda in PAUSA. Inizio accumulo file per sessione ${currentSessionId}`);
            await connectToChannel(member.voice.channel, currentSessionId);
            message.reply("🔊 **Modalità Ascolto Attiva**. Le risorse sono dedicate alla registrazione. L'elaborazione partirà alla fine.");
            checkAutoLeave(member.voice.channel);
        } else {
            message.reply("Devi essere in un canale vocale per evocare il Bardo!");
        }
    }

    // --- COMANDO STOPLISTENING (FINE SESSIONE) ---
    if (command === 'stoplistening') {
        if (!currentSessionId) {
            disconnect(message.guild.id);
            message.reply("Nessuna sessione attiva tracciata, ma mi sono disconnesso.");
            return;
        }

        const sessionIdEnded = currentSessionId;
        disconnect(message.guild.id);
        currentSessionId = null;

        message.reply(`🛑 Sessione **${sessionIdEnded}** terminata. Lo Scriba sta trascrivendo...`);
        
        await audioQueue.resume();
        console.log(`[Flow] Coda RIPRESA. I worker stanno elaborando i file accumulati...`);

        waitForCompletionAndSummarize(sessionIdEnded, message.channel as TextChannel);
    }

    // --- NUOVO: !racconta <id_sessione> [tono] ---
    if (command === 'racconta') {
        const targetSessionId = args[0];
        const requestedTone = args[1]?.toUpperCase() as ToneKey;

        if (!targetSessionId) {
            const sessions = getAvailableSessions();
            const list = sessions.map(s => `- \`${s.session_id}\` (${new Date(s.start_time).toLocaleString()}) - ${s.fragments} frammenti`).join('\n');
            return message.reply(`Uso: \`!racconta <ID> [TONO]\`\n\n**Sessioni recenti:**\n${list}`);
        }

        if (requestedTone && !TONES[requestedTone]) {
            return message.reply(`Tono non valido. Toni disponibili: ${Object.keys(TONES).join(', ')}`);
        }

        // FIX ERRORE TS2339: Castiamo a TextChannel per usare .send()
        const channel = message.channel as TextChannel;
        
        await channel.send(`📜 Il Bardo sta consultando gli archivi per la sessione \`${targetSessionId}\`...`);

        // CHIAMATA DIRETTA AL BARDO
        const summary = await generateSummary(targetSessionId, requestedTone || 'DM');
        
        // Invia i messaggi gestendo il limite di 2000 caratteri
        if (summary.length > 1900) {
            const chunks = summary.match(/[\s\S]{1,1900}/g) || [];
            for (const chunk of chunks) {
                await channel.send(chunk); // Ora 'channel' è tipizzato correttamente
            }
        } else {
            await channel.send(summary);
        }
    }

    // --- NUOVO: !listasessioni ---
    if (command === 'listasessioni') {
        const sessions = getAvailableSessions();
        if (sessions.length === 0) {
            message.reply("Nessuna sessione trovata negli archivi.");
        } else {
            const list = sessions.map(s => `- \`${s.session_id}\` (${new Date(s.start_time).toLocaleString()}) - ${s.fragments} frammenti`).join('\n');
            message.reply(`📜 **Sessioni Archiviate:**\n\n${list}`);
        }
    }

    // --- NUOVO: !toni ---
    if (command === 'toni') {
        const list = Object.entries(TONES).map(([key, desc]) => `**${key}**: ${desc}`).join('\n\n');
        message.reply(`🎭 **Toni Narrativi Disponibili:**\n\n${list}`);
    }

    // --- ALTRI COMANDI (IAM, MYCLASS, ETC) ---
    if (command === 'iam') {
        const val = args.join(' ');
        if (val) {
            updateUserField(message.author.id, 'character_name', val);
            message.reply(`⚔️ Nome aggiornato: **${val}**`);
        } else message.reply("Uso: `!iam Nome`");
    }

    if (command === 'myclass') {
        const val = args.join(' ');
        if (val) {
            updateUserField(message.author.id, 'class', val);
            message.reply(`🛡️ Classe aggiornata: **${val}**`);
        } else message.reply("Uso: `!myclass Barbaro / Mago / Ladro...`");
    }

    if (command === 'myrace') {
        const val = args.join(' ');
        if (val) {
            updateUserField(message.author.id, 'race', val);
            message.reply(`🧬 Razza aggiornata: **${val}**`);
        } else message.reply("Uso: `!myrace Umano / Elfo / Nano...`");
    }

    if (command === 'mydesc') {
        const val = args.join(' ');
        if (val) {
            updateUserField(message.author.id, 'description', val);
            message.reply(`📜 Descrizione aggiornata! Il Bardo prenderà nota.`);
        } else message.reply("Uso: `!mydesc Breve descrizione del carattere o aspetto`");
    }

    if (command === 'whoami') {
        const p = getUserProfile(message.author.id);
        if (p.character_name) {
            let msg = `👤 **${p.character_name}**`;
            if (p.race || p.class) msg += ` (${p.race || '?'} ${p.class || '?'})`;
            if (p.description) msg += `\n📝 "${p.description}"`;
            message.reply(msg);
        } else {
            message.reply("Non ti conosco. Usa `!iam` per iniziare.");
        }
    }
});

// --- FUNZIONE MONITORAGGIO CODA ---
async function waitForCompletionAndSummarize(sessionId: string, discordChannel: TextChannel) {
    const checkInterval = setInterval(async () => {
        const counts = await audioQueue.getJobCounts();
        
        if (counts.waiting === 0 && counts.active === 0 && counts.delayed === 0) {
            clearInterval(checkInterval);
            console.log("✅ Tutti i file processati. Generazione Riassunto...");
            
            const summary = await generateSummary(sessionId, 'DM');
            
            const today = new Date();
            const dateStr = today.toLocaleDateString('it-IT', {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
            });
            
            const chunks = summary.match(/[\s\S]{1,1900}/g) || [];
            
            await discordChannel.send(`\`\`\`diff\n-SESSIONE DEL ${dateStr.toUpperCase()}\n\`\`\``);
            
            for (const chunk of chunks) {
                await discordChannel.send(chunk);
            }
            
            console.log("📨 Riassunto inviato!");

        }
    }, 5000);
}

// --- AUTO LEAVE ---
client.on('voiceStateUpdate', (oldState, newState) => {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;
    const botMember = guild.members.cache.get(client.user!.id);
    if (!botMember?.voice.channel) return;
    checkAutoLeave(botMember.voice.channel);
});

function checkAutoLeave(channel: VoiceBasedChannel) {
    const humans = channel.members.filter(member => !member.user.bot).size;
    if (humans === 0) {
        if (!autoLeaveTimer) {
            console.log("👻 Canale vuoto. Timer 60s...");
            autoLeaveTimer = setTimeout(async () => {
                if (channel.guild) {
                    if (currentSessionId) {
                        const sessionIdEnded = currentSessionId;
                        disconnect(channel.guild.id);
                        currentSessionId = null;
                        await audioQueue.resume();
                        
                        const commandChannelId = process.env.DISCORD_COMMAND_AND_RESPONSE_CHANNEL_ID;
                        if (commandChannelId) {
                            const ch = await client.channels.fetch(commandChannelId) as TextChannel;
                            if (ch) {
                                ch.send("👻 Auto-Leave per inattività. Elaborazione sessione avviata...");
                                waitForCompletionAndSummarize(sessionIdEnded, ch);
                            }
                        }
                    } else {
                        disconnect(channel.guild.id);
                    }
                }
                autoLeaveTimer = null;
            }, 60000);
        }
    } else {
        if (autoLeaveTimer) {
            clearTimeout(autoLeaveTimer);
            autoLeaveTimer = null;
        }
    }
}

client.once('ready', () => {
    console.log(`🤖 Bot TS online: ${client.user?.tag}`);
});

client.login(process.env.DISCORD_BOT_TOKEN);
