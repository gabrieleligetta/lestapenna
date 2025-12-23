import 'dotenv/config';
import sodium from 'libsodium-wrappers';
import { Client, GatewayIntentBits, Message, VoiceBasedChannel, TextChannel, EmbedBuilder } from 'discord.js';
import { connectToChannel, disconnect } from './voicerecorder';
import { audioQueue, removeSessionJobs } from './queue';
import { generateSummary, TONES, ToneKey } from './bard';
import { 
    getAvailableSessions, 
    updateUserField, 
    getUserProfile, 
    getUnprocessedRecordings, 
    resetSessionData, 
    resetUnfinishedRecordings,
    getSessionNumber,
    getSessionAuthor,
    getUserName,
    getSessionStartTime
} from './db';
import { v4 as uuidv4 } from 'uuid';
import { startWorker } from './worker';

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

    // --- COMANDO HELP ---
    if (command === 'help' || command === 'aiuto') {
        const helpEmbed = new EmbedBuilder()
            .setTitle("🖋️ Lestapenna - Comandi Disponibili")
            .setColor("#D4AF37")
            .setDescription("Benvenuti, avventurieri! Io sono il vostro bardo e cronista personale.")
            .addFields(
                { name: "🎙️ Sessione", value: "`!listen`: Inizia la registrazione.\n`!stoplistening`: Termina e avvia il riassunto.\n`!reset <ID>`: Forza la rielaborazione di una sessione." },
                { name: "📜 Archivi", value: "`!listasessioni`: Ultime 5 sessioni.\n`!racconta <ID> [tono]`: Rigenera un riassunto.\n`!toni`: Elenco dei toni disponibili." },
                { name: "👤 Personaggio", value: "`!iam <Nome>`: Imposta il tuo nome.\n`!myclass <Classe>`: Imposta la tua classe.\n`!myrace <Razza>`: Imposta la tua razza.\n`!mydesc <Desc>`: Breve biografia.\n`!whoami`: Visualizza il tuo profilo." }
            )
            .setFooter({ text: "Lestapenna v1.1 - Per aspera ad astra" });
        
        return message.reply({ embeds: [helpEmbed] });
    }

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

    // --- NUOVO: !reset <id_sessione> ---
    if (command === 'reset') {
        const targetSessionId = args[0];
        if (!targetSessionId) {
            return message.reply("Uso: `!reset <ID_SESSIONE>` - Forza la rielaborazione completa.");
        }

        message.reply(`🔄 **Reset Sessione ${targetSessionId}** avviato...\n1. Pulizia coda...`);
        
        // 1. Rimuovi job vecchi dalla coda
        const removed = await removeSessionJobs(targetSessionId);
        
        // 2. Resetta DB
        const filesToProcess = resetSessionData(targetSessionId);
        
        if (filesToProcess.length === 0) {
            return message.reply(`⚠️ Nessun file trovato per la sessione ${targetSessionId}.`);
        }

        message.reply(`2. Database resettato (${filesToProcess.length} file trovati).\n3. Reinserimento in coda...`);

        // 3. Riaccoda
        for (const job of filesToProcess) {
            await audioQueue.add('transcribe-job', {
                sessionId: job.session_id,
                fileName: job.filename,
                filePath: job.filepath,
                userId: job.user_id
            }, {
                jobId: job.filename,
                attempts: 5,
                backoff: { type: 'exponential', delay: 2000 },
                removeOnComplete: true,
                removeOnFail: false // Teniamo i fallimenti per debug, ma removeSessionJobs li pulirà
            });
        }

        // Assicuriamoci che la coda sia attiva
        await audioQueue.resume();

        message.reply(`✅ **Reset Completato**. ${filesToProcess.length} file sono stati rimessi in coda. L'elaborazione è ripartita.`);
        
        // Avvia monitoraggio per il riassunto finale
        waitForCompletionAndSummarize(targetSessionId, message.channel as TextChannel);
    }

    // --- NUOVO: !racconta <id_sessione> [tono] ---
    if (command === 'racconta') {
        const targetSessionId = args[0];
        const requestedTone = args[1]?.toUpperCase() as ToneKey;

        if (!targetSessionId) {
            const sessions = getAvailableSessions();
            if (sessions.length === 0) return message.reply("Nessuna sessione trovata.");
            
            const list = sessions.map(s => `🆔 \`${s.session_id}\`\n📅 ${new Date(s.start_time).toLocaleString()} (${s.fragments} frammenti)`).join('\n\n');
            const embed = new EmbedBuilder()
                .setTitle("📜 Sessioni Disponibili")
                .setColor("#7289DA")
                .setDescription(list)
                .setFooter({ text: "Uso: !racconta <ID> [TONO]" });
            
            return message.reply({ embeds: [embed] });
        }

        if (requestedTone && !TONES[requestedTone]) {
            return message.reply(`Tono non valido. Toni disponibili: ${Object.keys(TONES).join(', ')}`);
        }

        const channel = message.channel as TextChannel;
        await channel.send(`📜 Il Bardo sta consultando gli archivi per la sessione \`${targetSessionId}\`...`);

        try {
            const summary = await generateSummary(targetSessionId, requestedTone || 'DM');
            await publishSummary(targetSessionId, summary, channel, true);
        } catch (err) {
            console.error(`❌ Errore durante il racconto della sessione ${targetSessionId}:`, err);
            await channel.send(`⚠️ Errore durante la generazione del riassunto.`);
        }
    }

    // --- NUOVO: !listasessioni ---
    if (command === 'listasessioni') {
        const sessions = getAvailableSessions();
        if (sessions.length === 0) {
            message.reply("Nessuna sessione trovata negli archivi.");
        } else {
            const list = sessions.map(s => `🆔 \`${s.session_id}\`\n📅 ${new Date(s.start_time).toLocaleString()} (${s.fragments} frammenti)`).join('\n\n');
            const embed = new EmbedBuilder()
                .setTitle("📜 Cronache delle Sessioni")
                .setColor("#7289DA")
                .setDescription(list);
            
            message.reply({ embeds: [embed] });
        }
    }

    // --- NUOVO: !toni ---
    if (command === 'toni') {
        const embed = new EmbedBuilder()
            .setTitle("🎭 Toni Narrativi")
            .setColor("#9B59B6")
            .setDescription("Scegli come deve essere raccontata la tua storia:")
            .addFields(Object.entries(TONES).map(([key, desc]) => ({ name: key, value: desc })));
        
        message.reply({ embeds: [embed] });
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
            const embed = new EmbedBuilder()
                .setTitle(`👤 Profilo di ${p.character_name}`)
                .setColor("#3498DB")
                .addFields(
                    { name: "⚔️ Nome", value: p.character_name || "Non impostato", inline: true },
                    { name: "🛡️ Classe", value: p.class || "Sconosciuta", inline: true },
                    { name: "🧬 Razza", value: p.race || "Sconosciuta", inline: true },
                    { name: "📜 Biografia", value: p.description || "Nessuna descrizione." }
                )
                .setThumbnail(message.author.displayAvatarURL());
            
            message.reply({ embeds: [embed] });
        } else {
            message.reply("Non ti conosco. Usa `!iam <Nome>` per iniziare la tua leggenda!");
        }
    }
});

// --- FUNZIONE MONITORAGGIO CODA ---
async function waitForCompletionAndSummarize(sessionId: string, discordChannel: TextChannel) {
    console.log(`[Monitor] Avviato monitoraggio per sessione ${sessionId}...`);
    
    const checkInterval = setInterval(async () => {
        // Recuperiamo tutti i job che potrebbero appartenere alla sessione
        const jobs = await audioQueue.getJobs(['waiting', 'active', 'delayed']);
        const sessionJobs = jobs.filter(j => j.data && j.data.sessionId === sessionId);
        
        if (sessionJobs.length > 0) {
            const details = await Promise.all(sessionJobs.map(async j => {
                const state = await j.getState();
                return `${j.data?.fileName} [${state}]`;
            }));
            console.log(`[Monitor] Sessione ${sessionId}: ancora ${sessionJobs.length} file da elaborare... (${details.join(', ')})`);
        } else {
            clearInterval(checkInterval);
            console.log(`✅ Sessione ${sessionId}: Tutti i file processati. Generazione Riassunto...`);
            
            try {
                const summary = await generateSummary(sessionId, 'DM');
                await publishSummary(sessionId, summary, discordChannel);
            } catch (err) {
                console.error(`❌ Errore durante il riassunto finale di ${sessionId}:`, err);
                await discordChannel.send(`⚠️ Errore durante la generazione del riassunto per la sessione \`${sessionId}\`. Puoi riprovare con \`!racconta ${sessionId}\`.`);
            }
        }
    }, 10000); // 10 secondi per non sovraccaricare Redis/CPU
}

/**
 * Invia il riassunto formattato al canale dedicato o a quello di fallback.
 */
async function publishSummary(sessionId: string, summary: string, defaultChannel: TextChannel, isReplay: boolean = false) {
    const summaryChannelId = process.env.DISCORD_SUMMARY_CHANNEL_ID;
    let targetChannel: TextChannel = defaultChannel;

    if (summaryChannelId) {
        try {
            const ch = await client.channels.fetch(summaryChannelId);
            if (ch && ch.isTextBased()) {
                targetChannel = ch as TextChannel;
            }
        } catch (e) {
            console.error("❌ Impossibile recuperare il canale dei riassunti specifico:", e);
        }
    }

    const sessionNum = getSessionNumber(sessionId);
    const authorId = getSessionAuthor(sessionId);
    const authorName = authorId ? (getUserName(authorId) || "Viandante") : "Viandante";
    const sessionStartTime = getSessionStartTime(sessionId);
    const sessionDate = new Date(sessionStartTime || Date.now());
    
    const dateStr = sessionDate.toLocaleDateString('it-IT');
    const dateShort = sessionDate.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });
    const timeStr = sessionDate.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

    const replayTag = isReplay ? " (REPLAY)" : "";
    await targetChannel.send(`\`\`\`diff\n-SESSIONE ${sessionNum} - ${dateStr}${replayTag}\n\`\`\``);
    await targetChannel.send(`**${authorName}** — ${dateShort}, ${timeStr}`);

    const chunks = summary.match(/[\s\S]{1,1900}/g) || [];
    for (const chunk of chunks) {
        await targetChannel.send(chunk);
    }
    
    // Se abbiamo inviato in un canale diverso da quello di origine, notifichiamo l'utente
    if (targetChannel.id !== defaultChannel.id) {
        await defaultChannel.send(`✅ Riassunto della sessione \`${sessionId}\` inviato in <#${targetChannel.id}>`);
    }

    console.log(`📨 Riassunto inviato per sessione ${sessionId} nel canale ${targetChannel.name}!`);
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

client.once('ready', async () => {
    console.log(`🤖 Bot TS online: ${client.user?.tag}`);

    // --- LOGICA DI RECOVERY AL RIAVVIO ---
    console.log("🔍 Controllo lavori interrotti nel database...");
    const orphanJobs = getUnprocessedRecordings();

    if (orphanJobs.length > 0) {
        // Estraiamo gli ID sessione univoci
        const sessionIds = [...new Set(orphanJobs.map(job => job.session_id))];
        console.log(`📦 Trovati ${orphanJobs.length} file orfani appartenenti a ${sessionIds.length} sessioni.`);

        // Recupero canale per i report (opzionale)
        const commandChannelId = process.env.DISCORD_COMMAND_AND_RESPONSE_CHANNEL_ID;
        let recoveryChannel: TextChannel | null = null;
        if (commandChannelId) {
            try {
                const ch = await client.channels.fetch(commandChannelId);
                if (ch && ch.isTextBased()) {
                    recoveryChannel = ch as TextChannel;
                }
            } catch (e) {
                console.error("❌ Impossibile recuperare il canale di recovery:", e);
            }
        }

        for (const sessionId of sessionIds) {
            console.log(`🔄 Ripristino automatico sessione ${sessionId}...`);
            
            // 1. Pulizia coda (sicurezza)
            await removeSessionJobs(sessionId);
            
            // 2. Reset DB (SOLO per i file non completati)
            const filesToProcess = resetUnfinishedRecordings(sessionId);
            
            // 3. Reinserimento
            for (const job of filesToProcess) {
                await audioQueue.add('transcribe-job', {
                    sessionId: job.session_id,
                    fileName: job.filename,
                    filePath: job.filepath,
                    userId: job.user_id
                }, {
                    jobId: job.filename,
                    attempts: 5,
                    backoff: { type: 'exponential', delay: 2000 },
                    removeOnComplete: true,
                    removeOnFail: false
                });
            }
            console.log(`✅ Sessione ${sessionId}: ${filesToProcess.length} file riaccodati.`);
            
            if (recoveryChannel) {
                recoveryChannel.send(`🔄 **Ripristino automatico** della sessione \`${sessionId}\` in corso...`);
                waitForCompletionAndSummarize(sessionId, recoveryChannel);
            }
        }
        
        // Assicuriamoci che la coda riparta
        await audioQueue.resume();

    } else {
        console.log("✨ Nessun lavoro in sospeso trovato.");
    }

    // --- AVVIO WORKER ---
    // Lo avviamo solo ora, dopo la recovery, per evitare race conditions sulla coda
    startWorker();
});

(async () => {
    await sodium.ready;
    client.login(process.env.DISCORD_BOT_TOKEN);
})();
