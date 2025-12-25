import 'dotenv/config';
import sodium from 'libsodium-wrappers';
import { 
    Client, 
    GatewayIntentBits, 
    Message, 
    VoiceBasedChannel, 
    TextChannel, 
    EmbedBuilder, 
    ChannelType, 
    DMChannel, 
    NewsChannel, 
    ThreadChannel,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    MessageComponentInteraction
} from 'discord.js';
import { connectToChannel, disconnect, wipeLocalFiles } from './voicerecorder';
import {uploadToOracle, downloadFromOracle, wipeBucket, getPresignedUrl} from './backupService';
import { audioQueue, removeSessionJobs, clearQueue } from './queue';
import * as fs from 'fs';
import { generateSummary, TONES, ToneKey, askBard, ingestSessionRaw } from './bard';
import { mixSessionAudio } from './sessionMixer';
import { 
    getAvailableSessions, 
    updateUserCharacter, 
    getUserProfile, 
    getUnprocessedRecordings, 
    resetSessionData, 
    updateRecordingStatus,
    resetUnfinishedRecordings,
    getSessionNumber,
    getSessionAuthor,
    getUserName,
    getSessionStartTime,
    setSessionNumber,
    getExplicitSessionNumber,
    findSessionByTimestamp,
    getRecording,
    addRecording,
    wipeDatabase,
    setConfig,
    getConfig,
    getSessionTranscript,
    getGuildConfig,
    setGuildConfig,
    createCampaign,
    getCampaigns,
    getActiveCampaign,
    setActiveCampaign,
    createSession,
    getSessionCampaignId
} from './db';
import { v4 as uuidv4 } from 'uuid';
import { startWorker } from './worker';
import * as path from 'path';
import { monitor, SessionMetrics } from './monitor';
import { processSessionReport, sendTestEmail } from './reporter';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const guildSessions = new Map<string, string>(); // GuildId -> SessionId
const autoLeaveTimers = new Map<string, NodeJS.Timeout>(); // GuildId -> Timer
const chatHistory = new Map<string, { role: 'user' | 'assistant', content: string }[]>(); // ChannelId -> History

const getCmdChannelId = (guildId: string) => getGuildConfig(guildId, 'cmd_channel_id') || process.env.DISCORD_COMMAND_AND_RESPONSE_CHANNEL_ID;
const getSummaryChannelId = (guildId: string) => getGuildConfig(guildId, 'summary_channel_id') || process.env.DISCORD_SUMMARY_CHANNEL_ID;

client.on('messageCreate', async (message: Message) => {
    if (!message.content.startsWith('!') || message.author.bot) return;
    if (!message.guild) return;

    const allowedChannelId = getCmdChannelId(message.guild.id);
    const isConfigCommand = message.content.startsWith('!setcmd');
    
    if (allowedChannelId && message.channelId !== allowedChannelId && !isConfigCommand) return;

    const args = message.content.slice(1).split(' ');
    const command = args.shift()?.toLowerCase();

    // --- COMANDI GESTIONE CAMPAGNE ---

    if (command === 'creacampagna') {
        const name = args.join(' ');
        if (!name) return await message.reply("Uso: `!creacampagna <Nome Campagna>`");
        
        createCampaign(message.guild.id, name);
        return await message.reply(`✅ Campagna **${name}** creata! Usa \`!selezionacampagna ${name}\` per attivarla.`);
    }

    if (command === 'listacampagne') {
        const campaigns = getCampaigns(message.guild.id);
        const active = getActiveCampaign(message.guild.id);
        
        if (campaigns.length === 0) return await message.reply("Nessuna campagna trovata. Creane una con `!creacampagna`.");

        const list = campaigns.map(c => 
            `${c.id === active?.id ? '👉 ' : ''}**${c.name}** (ID: ${c.id})`
        ).join('\n');

        const embed = new EmbedBuilder()
            .setTitle("🗺️ Campagne di questo Server")
            .setDescription(list)
            .setColor("#E67E22");
        
        return await message.reply({ embeds: [embed] });
    }

    if (command === 'selezionacampagna' || command === 'setcampagna') {
        const nameOrId = args.join(' ');
        if (!nameOrId) return await message.reply("Uso: `!selezionacampagna <Nome o ID>`");

        const campaigns = getCampaigns(message.guild.id);
        const target = campaigns.find(c => c.name.toLowerCase() === nameOrId.toLowerCase() || c.id.toString() === nameOrId);

        if (!target) return await message.reply("⚠️ Campagna non trovata.");

        setActiveCampaign(message.guild.id, target.id);
        return await message.reply(`✅ Campagna attiva impostata su: **${target.name}**.`);
    }

    // --- CHECK CAMPAGNA ATTIVA ---
    // Molti comandi richiedono una campagna attiva
    const activeCampaign = getActiveCampaign(message.guild.id);
    const campaignCommands = ['ascolta', 'sono', 'miaclasse', 'miarazza', 'miadesc', 'chisono', 'listasessioni', 'chiedialbardo', 'ingest', 'memorizza'];
    
    if (command && campaignCommands.includes(command) && !activeCampaign) {
        return await message.reply("⚠️ **Nessuna campagna attiva!**\nUsa `!creacampagna <Nome>` o `!selezionacampagna <Nome>` prima di iniziare.");
    }

    if (command === 'help' || command === 'aiuto') {
        const helpEmbed = new EmbedBuilder()
            .setTitle("🖋️ Lestapenna - Comandi Disponibili")
            .setColor("#D4AF37")
            .setDescription("Benvenuti, avventurieri! Io sono il vostro bardo e cronista personale.")
            .addFields(
                {
                    name: "🗺️ Campagne",
                    value:
                    "`!creacampagna <Nome>`: Crea nuova campagna.\n" +
                    "`!selezionacampagna <Nome>`: Attiva una campagna.\n" +
                    "`!listacampagne`: Mostra le campagne."
                },
                { 
                    name: "🎙️ Gestione Sessione", 
                    value: 
                    "`!ascolta`: Inizia la registrazione (Campagna Attiva).\n" +
                    "`!stop`: Termina la sessione.\n" +
                    "`!impostasessione <N>`: Imposta numero sessione.\n" +
                    "`!impostasessioneid <ID> <N>`: Corregge il numero." 
                },
                { 
                    name: "📜 Narrazione & Archivi", 
                    value: 
                    "`!listasessioni`: Ultime 5 sessioni (Campagna Attiva).\n" +
                    "`!racconta <ID> [tono]`: Rigenera riassunto.\n" +
                    "`!chiedialbardo <Domanda>`: Chiedi al Bardo qualcosa sulla storia.\n" +
                    "`!memorizza <ID>`: Indicizza manualmente una sessione nella memoria.\n" +
                    "`!scarica <ID>`: Scarica audio.\n" +
                    "`!scaricatrascrizioni <ID>`: Scarica testo trascrizioni (txt)." 
                },
                { 
                    name: "👤 Scheda Personaggio (Campagna Attiva)", 
                    value: 
                    "`!sono <Nome>`: Imposta il tuo nome.\n" +
                    "`!miaclasse <Classe>`: Imposta la tua classe.\n" +
                    "`!miarazza <Razza>`: Imposta la tua razza.\n" +
                    "`!miadesc <Testo>`: Aggiunge dettagli.\n" +
                    "`!chisono`: Visualizza la tua scheda." 
                },
                { 
                    name: "⚙️ Configurazione", 
                    value: 
                    "`!setcmd`: Imposta questo canale per i comandi.\n" +
                    "`!setsummary`: Imposta questo canale per la pubblicazione dei riassunti." 
                }
            );
        return await message.reply({ embeds: [helpEmbed] });
    }

    // --- COMANDI CONFIGURAZIONE CANALI ---
    if (command === 'setcmd') {
        if (!message.member?.permissions.has('ManageChannels')) {
            return await message.reply("⛔ Non hai il permesso di configurare il bot.");
        }
        setGuildConfig(message.guild.id, 'cmd_channel_id', message.channelId);
        return await message.reply(`✅ Canale Comandi impostato su <#${message.channelId}>.`);
    }

    if (command === 'setsummary') {
        if (!message.member?.permissions.has('ManageChannels')) {
            return await message.reply("⛔ Non hai il permesso di configurare il bot.");
        }
        setGuildConfig(message.guild.id, 'summary_channel_id', message.channelId);
        return await message.reply(`✅ Canale Riassunti impostato su <#${message.channelId}>.`);
    }

    // --- COMANDO LISTEN (INIZIO SESSIONE) ---
    if (command === 'listen' || command === 'ascolta') {
        const member = message.member;
        if (member?.voice.channel) {
            const voiceChannel = member.voice.channel;

            // 1. FILTRO BOT
            const humanMembers = voiceChannel.members.filter(m => !m.user.bot);
            const botMembers = voiceChannel.members.filter(m => m.user.bot);

            // 2. CHECK NOMI OBBLIGATORI (Context Aware)
            const missingNames: string[] = [];
            humanMembers.forEach(m => {
                const profile = getUserProfile(m.id, activeCampaign!.id);
                if (!profile.character_name) {
                    missingNames.push(m.displayName);
                }
            });

            if (missingNames.length > 0) {
                return await message.reply(
                    `🛑 **ALT!** Non posso iniziare la cronaca per **${activeCampaign!.name}**.\n` +
                    `I seguenti avventurieri non hanno dichiarato il loro nome in questa campagna:\n` +
                    missingNames.map(n => `- **${n}** (Usa: \`!sono NomePersonaggio\`)`).join('\n')
                );
            }
            
            if (botMembers.size > 0) {
                const botNames = botMembers.map(b => b.displayName).join(', ');
                await (message.channel as TextChannel).send(`🤖 Noto la presenza di costrutti magici (${botNames}). Le loro voci saranno ignorate.`);
            }

            const sessionId = uuidv4();
            guildSessions.set(message.guild.id, sessionId);
            
            // CREAZIONE SESSIONE NEL DB
            createSession(sessionId, message.guild.id, activeCampaign!.id);

            // START MONITOR
            monitor.startSession(sessionId);

            await audioQueue.pause();
            console.log(`[Flow] Coda in PAUSA. Inizio accumulo file per sessione ${sessionId}`);
            
            await connectToChannel(voiceChannel, sessionId);
            await message.reply(`🔊 **Cronaca Iniziata** per la campagna **${activeCampaign!.name}**.\nID Sessione: \`${sessionId}\`.\nI bardi stanno ascoltando ${humanMembers.size} eroi.`);
            checkAutoLeave(voiceChannel);
        } else {
            await message.reply("Devi essere in un canale vocale per evocare il Bardo!");
        }
    }

    // --- COMANDO STOPLISTENING (FINE SESSIONE) ---
    if (command === 'stoplistening' || command === 'stop') {
        const sessionId = guildSessions.get(message.guild.id);
        if (!sessionId) {
            disconnect(message.guild.id);
            await message.reply("Nessuna sessione attiva tracciata, ma mi sono disconnesso.");
            return;
        }

        disconnect(message.guild.id);
        guildSessions.delete(message.guild.id);

        await message.reply(`🛑 Sessione **${sessionId}** terminata. Lo Scriba sta trascrivendo...`);
        
        await audioQueue.resume();
        console.log(`[Flow] Coda RIPRESA. I worker stanno elaborando i file accumulati...`);

        await waitForCompletionAndSummarize(sessionId, message.channel as TextChannel);
    }

    // --- NUOVO: !setsession <numero> ---
    if (command === 'setsession' || command === 'impostasessione') {
        const sessionId = guildSessions.get(message.guild.id);
        if (!sessionId) {
            return await message.reply("⚠️ Nessuna sessione attiva. Avvia prima una sessione con `!ascolta`.");
        }

        const sessionNum = parseInt(args[0]);
        if (isNaN(sessionNum) || sessionNum <= 0) {
            return await message.reply("Uso: `!impostasessione <numero>` (es. `!impostasessione 5`)");
        }

        setSessionNumber(sessionId, sessionNum);
        await message.reply(`✅ Numero sessione impostato a **${sessionNum}**. Sarà usato per il prossimo riassunto.`);
    }

    // --- NUOVO: !setsessionid <id_sessione> <numero> ---
    if (command === 'setsessionid' || command === 'impostasessioneid') {
        const targetSessionId = args[0];
        const sessionNum = parseInt(args[1]);

        if (!targetSessionId || isNaN(sessionNum)) {
            return await message.reply("Uso: `!impostasessioneid <ID_SESSIONE> <NUMERO>`");
        }

        setSessionNumber(targetSessionId, sessionNum);
        await message.reply(`✅ Numero sessione per \`${targetSessionId}\` impostato a **${sessionNum}**.`);
    }

    // --- NUOVO: !reset <id_sessione> ---
    if (command === 'reset') {
        const targetSessionId = args[0];
        if (!targetSessionId) {
            return await message.reply("Uso: `!reset <ID_SESSIONE>` - Forza la rielaborazione completa.");
        }

        await message.reply(`🔄 **Reset Sessione ${targetSessionId}** avviato...\n1. Pulizia coda...`);
        
        const removed = await removeSessionJobs(targetSessionId);
        const filesToProcess = resetSessionData(targetSessionId);
        
        if (filesToProcess.length === 0) {
            return await message.reply(`⚠️ Nessun file trovato per la sessione ${targetSessionId}.`);
        }

        await message.reply(`2. Database resettato (${filesToProcess.length} file trovati).\n3. Ripristino file e reinserimento in coda...`);

        let restoredCount = 0;

        for (const job of filesToProcess) {
            if (!fs.existsSync(job.filepath)) {
                const success = await downloadFromOracle(job.filename, job.filepath, targetSessionId);
                if (success) restoredCount++;
            }

            try {
                const uploaded = await uploadToOracle(job.filepath, job.filename, targetSessionId);
                if (uploaded) {
                    updateRecordingStatus(job.filename, 'SECURED');
                }
            } catch (err) {
                console.error(`[Custode] Fallimento upload durante reset per ${job.filename}:`, err);
            }

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

        await audioQueue.resume();

        let statusMsg = `✅ **Reset Completato**. ${filesToProcess.length} file sono stati rimessi in coda.`;
        if (restoredCount > 0) {
            statusMsg += `\n📦 ${restoredCount} file mancanti sono stati ripristinati dal Cloud.`;
        }

        await message.reply(statusMsg);
        await waitForCompletionAndSummarize(targetSessionId, message.channel as TextChannel);
    }

    // --- NUOVO: !scaricatrascrizioni <ID> ---
    if (command === 'scaricatrascrizioni' || command === 'downloadtxt') {
        const targetSessionId = args[0];
        if (!targetSessionId) {
            return await message.reply("Uso: `!scaricatrascrizioni <ID>`");
        }

        const transcripts = getSessionTranscript(targetSessionId);
        if (!transcripts || transcripts.length === 0) {
            return await message.reply(`⚠️ Nessuna trascrizione trovata per la sessione \`${targetSessionId}\`.`);
        }

        const formattedText = transcripts.map(t => {
            let text = "";
            const startTime = getSessionStartTime(targetSessionId) || 0;
            
            try {
                const segments = JSON.parse(t.transcription_text);
                if (Array.isArray(segments)) {
                    text = segments.map(s => {
                        const absTime = t.timestamp + (s.start * 1000);
                        const mins = Math.floor((absTime - startTime) / 60000);
                        const secs = Math.floor(((absTime - startTime) % 60000) / 1000);
                        return `[${mins}:${secs.toString().padStart(2, '0')}] ${s.text}`;
                    }).join('\n');
                } else {
                    text = t.transcription_text;
                }
            } catch (e) {
                text = t.transcription_text;
            }
            
            return `--- ${t.character_name || 'Sconosciuto'} (File: ${new Date(t.timestamp).toLocaleTimeString()}) ---\n${text}\n`;
        }).join('\n');


        const fileName = `transcript-${targetSessionId}.txt`;
        const filePath = path.join(__dirname, '..', 'recordings', fileName);
        
        fs.writeFileSync(filePath, formattedText);

        await message.reply({
            content: `📜 **Trascrizione Completa** per sessione \`${targetSessionId}\``,
            files: [filePath]
        });

        try { fs.unlinkSync(filePath); } catch (e) {}
    }

    // --- MODIFICATO: !racconta <id_sessione> [tono] ---
    if (command === 'racconta') {
        const targetSessionId = args[0];
        const requestedTone = args[1]?.toUpperCase() as ToneKey;

        if (!targetSessionId) {
             // Mostra sessioni della campagna attiva
             const sessions = getAvailableSessions(message.guild.id, activeCampaign?.id);
             if (sessions.length === 0) return await message.reply("Nessuna sessione trovata per questa campagna.");
             const list = sessions.map(s => `🆔 \`${s.session_id}\`\n📅 ${new Date(s.start_time).toLocaleString()} (${s.fragments} frammenti)`).join('\n\n');
             const embed = new EmbedBuilder().setTitle(`📜 Sessioni: ${activeCampaign?.name}`).setDescription(list);
             return await message.reply({ embeds: [embed] });
        }

        if (requestedTone && !TONES[requestedTone]) {
            return await message.reply(`Tono non valido. Toni: ${Object.keys(TONES).join(', ')}`);
        }

        const channel = message.channel as TextChannel;
        await channel.send(`📜 Il Bardo sta consultando gli archivi per la sessione \`${targetSessionId}\`...`);

        const startProcessing = Date.now();
        try {
            // FEEDBACK INGESTIONE
            await channel.send("🧠 Il Bardo sta studiando gli eventi per ricordarli in futuro...");
            await ingestSessionRaw(targetSessionId);
            await channel.send("✅ Memoria aggiornata. Inizio stesura del racconto...");

            const result = await generateSummary(targetSessionId, requestedTone || 'DM');
            await publishSummary(targetSessionId, result.summary, channel, true);

            const processingTime = Date.now() - startProcessing;
            const transcripts = getSessionTranscript(targetSessionId);
            
            const replayMetrics: SessionMetrics = {
                sessionId: targetSessionId,
                startTime: startProcessing,
                endTime: Date.now(),
                totalFiles: transcripts.length,
                totalAudioDurationSec: 0,
                transcriptionTimeMs: 0,
                summarizationTimeMs: processingTime,
                totalTokensUsed: result.tokens,
                errors: [],
                resourceUsage: { cpuSamples: [], ramSamplesMB: [] }
            };

            processSessionReport(replayMetrics).catch(e => console.error("Err Report Replay:", e));

        } catch (err) {
            console.error(`❌ Errore racconta ${targetSessionId}:`, err);
            await channel.send(`⚠️ Errore durante la generazione del riassunto.`);
        }
    }

    // --- NUOVO: !chiedialbardo <Domanda> ---
    if (command === 'chiedialbardo' || command === 'ask') {
        const question = args.join(' ');
        if (!question) return await message.reply("Uso: `!chiedialbardo <Domanda>`");

        // Fix per TS2339: Controllo se il canale supporta sendTyping
        if ('sendTyping' in message.channel) {
            await (message.channel as TextChannel | DMChannel | NewsChannel | ThreadChannel).sendTyping();
        }

        try {
            // GESTIONE MEMORIA BREVE
            const history = chatHistory.get(message.channelId) || [];
            const answer = await askBard(activeCampaign!.id, question, history);
            
            // Aggiorna cronologia
            history.push({ role: 'user', content: question });
            history.push({ role: 'assistant', content: answer });
            
            // Mantieni solo ultimi 6 messaggi (3 scambi)
            if (history.length > 6) history.splice(0, history.length - 6);
            chatHistory.set(message.channelId, history);

            await message.reply(answer);
        } catch (err) {
            console.error("Errore chiedialbardo:", err);
            await message.reply("Il Bardo ha un vuoto di memoria...");
        }
    }

    // --- NUOVO: !ingest <session_id> ---
    if (command === 'ingest' || command === 'memorizza') {
        const targetSessionId = args[0];
        if (!targetSessionId) return await message.reply("Uso: `!ingest <ID_SESSIONE>`");

        await message.reply(`🧠 **Ingestione Memoria** avviata per sessione \`${targetSessionId}\`...\nSto leggendo le trascrizioni e creando i vettori.`);
        
        try {
            await ingestSessionRaw(targetSessionId);
            await message.reply(`✅ Memoria aggiornata per sessione \`${targetSessionId}\`. Ora puoi farmi domande su di essa.`);
        } catch (e: any) {
            console.error(e);
            await message.reply(`❌ Errore durante l'ingestione: ${e.message}`);
        }
    }

    // --- COMANDO DOWNLOAD SESSIONE ---
    if (command === 'download' || command === 'scarica') {
        const isActiveSession = guildSessions.has(message.guild.id);
        const queueCounts = await audioQueue.getJobCounts();
        const isProcessing = queueCounts.active > 0 || queueCounts.waiting > 0;

        if (isActiveSession || isProcessing) {
            return await message.reply(
                `🛑 **Sistema sotto carico.**\n` +
                `Non posso generare il download mentre:\n` +
                `- Una sessione è attiva: ${isActiveSession ? 'SÌ' : 'NO'}\n` +
                `- Ci sono file in elaborazione: ${isProcessing ? 'SÌ' : 'NO'} (${queueCounts.waiting} in coda)\n\n` +
                `Attendi la fine della sessione e del riassunto.`
            );
        }

        let targetSessionId = args[0];
        
        if (!targetSessionId) {
            targetSessionId = guildSessions.get(message.guild.id) || "";
        }

        if (!targetSessionId) {
            return await message.reply("⚠️ Specifica un ID sessione o avvia una sessione: `!scarica <ID>`");
        }

        await message.reply(`⏳ **Elaborazione Audio Completa** per sessione \`${targetSessionId}\`...\nPotrebbe volerci qualche minuto a seconda della durata. Ti avviserò qui.`);

        try {
            const filePath = await mixSessionAudio(targetSessionId);
            const stats = fs.statSync(filePath);
            const sizeMB = stats.size / (1024 * 1024);

            if (sizeMB < 25) {
                await (message.channel as TextChannel).send({
                    content: `✅ **Audio Sessione Pronto!** (${sizeMB.toFixed(2)} MB)`,
                    files: [filePath]
                });
            } else {
                const fileName = path.basename(filePath);
                await uploadToOracle(filePath, fileName, targetSessionId);
                const presignedUrl = await getPresignedUrl(fileName, targetSessionId, 3600 * 24);

                if (presignedUrl) {
                    await (message.channel as TextChannel).send(`✅ **Audio Generato** (${sizeMB.toFixed(2)} MB).\nEssendo troppo grande per Discord, puoi scaricarlo qui (link valido 24h):\n${presignedUrl}`);
                } else {
                    await (message.channel as TextChannel).send(`✅ **Audio Generato** (${sizeMB.toFixed(2)} MB), ma non sono riuscito a generare il link di download.`);
                }

                try { fs.unlinkSync(filePath); } catch(e) {}
            }

        } catch (err: any) {
            console.error(err);
            await (message.channel as TextChannel).send(`❌ Errore durante la generazione dell'audio: ${err.message}`);
        }
    }

    // --- NUOVO: !listasessioni ---
    if (command === 'listasessioni') {
        const sessions = getAvailableSessions(message.guild.id, activeCampaign?.id);
        if (sessions.length === 0) {
            await message.reply("Nessuna sessione trovata negli archivi per questa campagna.");
        } else {
            const list = sessions.map(s => `🆔 \`${s.session_id}\`\n📅 ${new Date(s.start_time).toLocaleString()} (${s.fragments} frammenti)`).join('\n\n');
            const embed = new EmbedBuilder()
                .setTitle(`📜 Cronache: ${activeCampaign?.name}`)
                .setColor("#7289DA")
                .setDescription(list);
            
            await message.reply({ embeds: [embed] });
        }
    }

    // --- NUOVO: !toni ---
    if (command === 'toni') {
        const embed = new EmbedBuilder()
            .setTitle("🎭 Toni Narrativi")
            .setColor("#9B59B6")
            .setDescription("Scegli come deve essere raccontata la tua storia:")
            .addFields(Object.entries(TONES).map(([key, desc]) => ({ name: key, value: desc })));
        
        await message.reply({ embeds: [embed] });
    }

    // --- NUOVO: !wipe (SOLO SVILUPPO) ---
    if (command === 'wipe') {
        if (message.author.id !== '310865403066712074') return;

        const filter = (m: Message) => m.author.id === message.author.id;
        await message.reply("⚠️ **ATTENZIONE**: Questa operazione cancellerà **TUTTO** (DB, Cloud, Code, File Locali). Sei sicuro? Scrivi `CONFERMO` entro 15 secondi.");

        try {
            const collected = await (message.channel as TextChannel).awaitMessages({
                filter: (m: Message) => m.author.id === message.author.id && m.content === 'CONFERMO',
                max: 1, 
                time: 15000, 
                errors: ['time'] 
            });

            if (collected.size > 0) {
                const statusMsg = await message.reply("🧹 **Ragnarok avviato...**");
                try {
                    await clearQueue();
                    await statusMsg.edit("🧹 **Ragnarok in corso...**\n- Code svuotate ✅");
                    const cloudCount = await wipeBucket();
                    await statusMsg.edit(`🧹 **Ragnarok in corso...**\n- Code svuotate ✅\n- Cloud svuotato (${cloudCount} oggetti rimossi) ✅`);
                    wipeDatabase();
                    await statusMsg.edit(`🧹 **Ragnarok in corso...**\n- Code svuotate ✅\n- Cloud svuotato (${cloudCount} oggetti rimossi) ✅\n- Database resettato ✅`);
                    wipeLocalFiles();
                    await statusMsg.edit(`🔥 **Ragnarok completato.** Tutto è stato riportato al nulla.\n- Code svuotate ✅\n- Cloud svuotato (${cloudCount} oggetti rimossi) ✅\n- Database resettato ✅\n- File locali eliminati ✅`);
                } catch (err: any) {
                    console.error("❌ Errore durante il wipe:", err);
                    await statusMsg.edit(`❌ Errore durante il Ragnarok: ${err.message}`);
                }
            }
        } catch (e) {
            await message.reply("⌛ Tempo scaduto. Il mondo è salvo.");
        }
    }

    // --- NUOVO: !testmail (HIDDEN) ---
    if (command === 'testmail') {
        if (message.author.id !== '310865403066712074') return;

        await message.reply("📧 Invio email di test in corso...");
        const success = await sendTestEmail('gabligetta@gmail.com');
        
        if (success) {
            await message.reply("✅ Email inviata con successo! Controlla la casella di posta.");
        } else {
            await message.reply("❌ Errore durante l'invio. Controlla i log della console.");
        }
    }

    // --- ALTRI COMANDI (IAM, MYCLASS, ETC) ---
    if (command === 'iam' || command === 'sono') {
        const val = args.join(' ');
        if (val) {
            if (val.toUpperCase() === 'DM' || val.toUpperCase() === 'DUNGEON MASTER') {
                updateUserCharacter(message.author.id, activeCampaign!.id, 'character_name', 'DM');
                updateUserCharacter(message.author.id, activeCampaign!.id, 'class', 'Dungeon Master');
                updateUserCharacter(message.author.id, activeCampaign!.id, 'race', 'Narratore');
                await message.reply(`🎲 **Saluti, Dungeon Master.** Il Bardo è ai tuoi ordini per la campagna **${activeCampaign!.name}**.`);
            } else {
                updateUserCharacter(message.author.id, activeCampaign!.id, 'character_name', val);
                await message.reply(`⚔️ Nome aggiornato: **${val}** (Campagna: ${activeCampaign!.name})`);
            }
        } else await message.reply("Uso: `!sono Nome`");
    }

    if (command === 'myclass' || command === 'miaclasse') {
        const val = args.join(' ');
        if (val) {
            updateUserCharacter(message.author.id, activeCampaign!.id, 'class', val);
            await message.reply(`🛡️ Classe aggiornata: **${val}**`);
        } else await message.reply("Uso: `!miaclasse Barbaro / Mago / Ladro...`");
    }

    if (command === 'myrace' || command === 'miarazza') {
        const val = args.join(' ');
        if (val) {
            updateUserCharacter(message.author.id, activeCampaign!.id, 'race', val);
            await message.reply(`🧬 Razza aggiornata: **${val}**`);
        } else await message.reply("Uso: `!miarazza Umano / Elfo / Nano...`");
    }

    if (command === 'mydesc' || command === 'miadesc') {
        const val = args.join(' ');
        if (val) {
            updateUserCharacter(message.author.id, activeCampaign!.id, 'description', val);
            await message.reply(`📜 Descrizione aggiornata! Il Bardo prenderà nota.`);
        } else await message.reply("Uso: `!miadesc Breve descrizione del carattere o aspetto`");
    }

    if (command === 'whoami' || command === 'chisono') {
        const p = getUserProfile(message.author.id, activeCampaign!.id);
        if (p.character_name) {
            const embed = new EmbedBuilder()
                .setTitle(`👤 Profilo di ${p.character_name}`)
                .setDescription(`Campagna: **${activeCampaign!.name}**`)
                .setColor("#3498DB")
                .addFields(
                    { name: "⚔️ Nome", value: p.character_name || "Non impostato", inline: true },
                    { name: "🛡️ Classe", value: p.class || "Sconosciuta", inline: true },
                    { name: "🧬 Razza", value: p.race || "Sconosciuta", inline: true },
                    { name: "📜 Biografia", value: p.description || "Nessuna descrizione." }
                )
                .setThumbnail(message.author.displayAvatarURL());
            
            await message.reply({ embeds: [embed] });
        } else {
            await message.reply("Non ti conosco in questa campagna. Usa `!sono <Nome>` per iniziare la tua leggenda!");
        }
    }
});

// --- FUNZIONE MONITORAGGIO CODA ---
async function waitForCompletionAndSummarize(sessionId: string, discordChannel: TextChannel) {
    console.log(`[Monitor] Avviato monitoraggio per sessione ${sessionId}...`);
    
    const checkInterval = setInterval(async () => {
        const jobs = await audioQueue.getJobs(['waiting', 'active', 'delayed']);
        const sessionJobs = jobs.filter(j => j.data && j.data.sessionId === sessionId);
        
        if (sessionJobs.length > 0) {
             const details = await Promise.all(sessionJobs.map(async j => {
                const state = await j.getState();
                return `${j.data?.fileName} [${state}]`;
            }));
            console.log(`[Monitor] Sessione ${sessionId}: ancora ${sessionJobs.length} file... (${details.join(', ')})`);
        } else {
            clearInterval(checkInterval);
            console.log(`✅ Sessione ${sessionId}: Tutti i file processati. Generazione Riassunto...`);
            
            const startSummary = Date.now();
            try {
                // FEEDBACK INGESTIONE
                await discordChannel.send("🧠 Il Bardo sta studiando gli eventi per ricordarli in futuro...");
                await ingestSessionRaw(sessionId);
                await discordChannel.send("✅ Memoria aggiornata. Inizio stesura del racconto...");

                const result = await generateSummary(sessionId, 'DM');
                
                monitor.logSummarizationTime(Date.now() - startSummary);
                monitor.logTokenUsage(result.tokens);

                await publishSummary(sessionId, result.summary, discordChannel);
            } catch (err: any) {
                console.error(`❌ Errore riassunto finale ${sessionId}:`, err);
                monitor.logError('Summary', err.message);
                await discordChannel.send(`⚠️ Errore riassunto. Riprova: \`!racconta ${sessionId}\`.`);
            }

            const metrics = monitor.endSession();
            if (metrics) {
                processSessionReport(metrics).catch(e => console.error(e));
            }
        }
    }, 10000);
}

async function fetchSessionInfoFromHistory(channel: TextChannel, targetSessionId?: string): Promise<{ lastRealNumber: number, sessionNumber?: number }> {
    let lastRealNumber = 0;
    let foundSessionNumber: number | undefined;

    try {
        const messages = await channel.messages.fetch({ limit: 100 });
        const sortedMessages = Array.from(messages.values()).sort((a, b) => b.createdTimestamp - a.createdTimestamp);

        for (const msg of sortedMessages) {
            const sessionMatch = msg.content.match(/-SESSIONE\s+(\d+)/i);
            const idMatch = msg.content.match(/\[ID: ([a-f0-9-]+)\]/i);
            const isReplay = msg.content.includes("(REPLAY)");

            if (sessionMatch) {
                const num = parseInt(sessionMatch[1]);
                if (!isNaN(num)) {
                    if (!isReplay && lastRealNumber === 0) {
                        lastRealNumber = num;
                    }
                    if (targetSessionId && idMatch && idMatch[1] === targetSessionId) {
                        foundSessionNumber = num;
                    }
                    if (!targetSessionId && lastRealNumber !== 0) break;
                    if (targetSessionId && lastRealNumber !== 0 && foundSessionNumber !== undefined) break;
                }
            }
        }
    } catch (e) {
        console.error("❌ Errore durante il recupero della cronologia del canale:", e);
    }

    return { lastRealNumber, sessionNumber: foundSessionNumber };
}

async function publishSummary(sessionId: string, summary: string, defaultChannel: TextChannel, isReplay: boolean = false) {
    const summaryChannelId = getSummaryChannelId(defaultChannel.guild.id);
    let targetChannel: TextChannel = defaultChannel;
    let discordSummaryChannel: TextChannel | null = null;

    if (summaryChannelId) {
        try {
            const ch = await client.channels.fetch(summaryChannelId);
            if (ch && ch.isTextBased()) {
                discordSummaryChannel = ch as TextChannel;
                targetChannel = discordSummaryChannel;
            }
        } catch (e) {
            console.error("❌ Impossibile recuperare il canale dei riassunti specifico:", e);
        }
    }

    let sessionNum = getExplicitSessionNumber(sessionId);
    if (sessionNum !== null) {
        console.log(`[Publish] Sessione ${sessionId}: Usato numero manuale ${sessionNum}`);
    }

    if (sessionNum === null && discordSummaryChannel) {
        const info = await fetchSessionInfoFromHistory(discordSummaryChannel, sessionId);
        if (isReplay) {
            if (info.sessionNumber) {
                sessionNum = info.sessionNumber;
                setSessionNumber(sessionId, sessionNum);
            }
        } else {
            if (info.lastRealNumber > 0) {
                sessionNum = info.lastRealNumber + 1;
                setSessionNumber(sessionId, sessionNum);
            }
        }
    }

    if (sessionNum === null) {
        sessionNum = 1;
        setSessionNumber(sessionId, sessionNum);
    }

    const authorId = getSessionAuthor(sessionId);
    const campaignId = getSessionCampaignId(sessionId);
    const authorName = authorId && campaignId ? (getUserName(authorId, campaignId) || "Viandante") : "Viandante";
    const sessionStartTime = getSessionStartTime(sessionId);
    const sessionDate = new Date(sessionStartTime || Date.now());
    
    const dateStr = sessionDate.toLocaleDateString('it-IT');
    const dateShort = sessionDate.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });
    const timeStr = sessionDate.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

    const replayTag = isReplay ? " (REPLAY)" : "";
    
    // Header con nome campagna se disponibile
    let header = `-SESSIONE ${sessionNum} - ${dateStr}${replayTag}\n[ID: ${sessionId}]`;
    if (campaignId) {
        const campaigns = getCampaigns(defaultChannel.guild.id);
        const campaign = campaigns.find(c => c.id === campaignId);
        if (campaign) {
            header = `--- ${campaign.name.toUpperCase()} ---\n` + header;
        }
    }

    // --- PAGINAZIONE ---
    const PAGE_SIZE = 2000;
    const pages: string[] = [];
    
    for (let i = 0; i < summary.length; i += PAGE_SIZE) {
        pages.push(summary.substring(i, i + PAGE_SIZE));
    }

    const generateEmbed = (pageIndex: number) => {
        return new EmbedBuilder()
            .setTitle(`📜 Cronaca Sessione ${sessionNum}`)
            .setDescription(pages[pageIndex])
            .setColor("#F1C40F")
            .setFooter({ text: `Pagina ${pageIndex + 1} di ${pages.length} • ${header}` })
            .setTimestamp();
    };

    const generateButtons = (pageIndex: number) => {
        const row = new ActionRowBuilder<ButtonBuilder>();
        
        row.addComponents(
            new ButtonBuilder()
                .setCustomId('prev')
                .setLabel('⬅️ Precedente')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(pageIndex === 0),
            new ButtonBuilder()
                .setCustomId('next')
                .setLabel('Successiva ➡️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(pageIndex === pages.length - 1)
        );
        
        return row;
    };

    const messageOptions: any = { 
        embeds: [generateEmbed(0)],
        content: `**${authorName}** — ${dateShort}, ${timeStr}`
    };

    if (pages.length > 1) {
        messageOptions.components = [generateButtons(0)];
    }

    const sentMessage = await targetChannel.send(messageOptions);

    if (pages.length > 1) {
        const collector = sentMessage.createMessageComponentCollector({ 
            componentType: ComponentType.Button, 
            time: 600000 // 10 minuti
        });

        let currentPage = 0;

        collector.on('collect', async (i: MessageComponentInteraction) => {
            if (i.customId === 'prev') {
                currentPage = Math.max(0, currentPage - 1);
            } else if (i.customId === 'next') {
                currentPage = Math.min(pages.length - 1, currentPage + 1);
            }

            await i.update({
                embeds: [generateEmbed(currentPage)],
                components: [generateButtons(currentPage)]
            });
        });

        collector.on('end', async () => {
            // Disabilita bottoni alla fine
            const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('prev').setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(true),
                new ButtonBuilder().setCustomId('next').setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(true)
            );
            try {
                await sentMessage.edit({ components: [disabledRow] });
            } catch (e) {}
        });
    }
    
    if (targetChannel.id !== defaultChannel.id) {
        await defaultChannel.send(`✅ Riassunto della sessione \`${sessionId}\` inviato in <#${targetChannel.id}>`);
    }

    console.log(`📨 Riassunto inviato per sessione ${sessionId} nel canale ${targetChannel.name}!`);
}


async function recoverOrphanedFiles() {
    const recordingsDir = path.join(__dirname, '..', 'recordings');
    if (!fs.existsSync(recordingsDir)) return;

    const files = fs.readdirSync(recordingsDir);
    const mp3Files = files.filter(f => f.endsWith('.mp3'));

    if (mp3Files.length === 0) return;

    console.log(`🔍 Scansione file orfani in corso (${mp3Files.length} file trovati)...`);
    let recoveredCount = 0;

    for (const file of mp3Files) {
        const filePath = path.join(recordingsDir, file);
        const match = file.match(/^(.+)-(\d+)\.mp3$/);
        if (!match) continue;

        const userId = match[1];
        const timestamp = parseInt(match[2]);

        const existing = getRecording(file);
        if (existing) continue;

        if (Date.now() - timestamp < 300000) continue; 

        console.log(`🩹 Trovato file orfano: ${file}. Tento recupero...`);

        let sessionId = findSessionByTimestamp(timestamp);
        
        if (!sessionId) {
            sessionId = `recovered-${uuidv4().substring(0, 8)}`;
            console.log(`🆕 Nessuna sessione trovata per ${file}. Creo sessione di emergenza: ${sessionId}`);
            // Nota: Le sessioni recuperate non avranno campagna associata, andranno gestite manualmente o assegnate a una campagna di default
            // Per ora creiamo una sessione "orfana" nel DB se non esiste
            createSession(sessionId, 'unknown', 0); 
        }

        addRecording(sessionId, file, filePath, userId, timestamp);

        try {
            const uploaded = await uploadToOracle(filePath, file, sessionId);
            if (uploaded) {
                updateRecordingStatus(file, 'SECURED');
            }
        } catch (err) {
            console.error(`[Recovery] Fallimento upload per ${file}:`, err);
        }

        await audioQueue.add('transcribe-job', {
            sessionId,
            fileName: file,
            filePath,
            userId
        }, {
            jobId: file,
            attempts: 5,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: true,
            removeOnFail: false
        });

        recoveredCount++;
    }

    if (recoveredCount > 0) {
        console.log(`✅ Recupero completato: ${recoveredCount} file orfani ripristinati.`);
    }
}

client.on('voiceStateUpdate', (oldState, newState) => {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;
    const botMember = guild.members.cache.get(client.user!.id);
    if (!botMember?.voice.channel) return;
    checkAutoLeave(botMember.voice.channel);
});

function checkAutoLeave(channel: VoiceBasedChannel) {
    const humans = channel.members.filter(member => !member.user.bot).size;
    const guildId = channel.guild.id;

    if (humans === 0) {
        if (!autoLeaveTimers.has(guildId)) {
            console.log(`👻 Canale vuoto in ${guildId}. Timer 60s...`);
            const timer = setTimeout(async () => {
                const sessionId = guildSessions.get(guildId);
                if (sessionId) {
                    disconnect(guildId);
                    guildSessions.delete(guildId);
                    await audioQueue.resume();
                    
                    const commandChannelId = getCmdChannelId(guildId);
                    if (commandChannelId) {
                        const ch = await client.channels.fetch(commandChannelId) as TextChannel;
                        if (ch) {
                            await ch.send(`👻 Auto-Leave per inattività in <#${channel.id}>. Elaborazione sessione avviata...`);
                            await waitForCompletionAndSummarize(sessionId, ch);
                        }
                    }
                } else {
                    disconnect(guildId);
                }
                autoLeaveTimers.delete(guildId);
            }, 60000);
            autoLeaveTimers.set(guildId, timer);
        }
    } else {
        const timer = autoLeaveTimers.get(guildId);
        if (timer) {
            clearTimeout(timer);
            autoLeaveTimers.delete(guildId);
        }
    }
}

client.once('ready', async () => {
    console.log(`🤖 Bot TS online: ${client.user?.tag}`);

    await recoverOrphanedFiles();

    console.log("🔍 Controllo lavori interrotti nel database...");
    const orphanJobs = getUnprocessedRecordings();

    if (orphanJobs.length > 0) {
        const sessionIds = [...new Set(orphanJobs.map(job => job.session_id))];
        console.log(`📦 Trovati ${orphanJobs.length} file orfani appartenenti a ${sessionIds.length} sessioni.`);

        // Nota: Il recupero automatico potrebbe non avere il canale corretto se multi-guild.
        // Per ora logghiamo e basta, il recupero avverrà ma senza notifica in chat se non riusciamo a dedurre il canale.
        
        for (const sessionId of sessionIds) {
            console.log(`🔄 Ripristino automatico sessione ${sessionId}...`);
            await removeSessionJobs(sessionId);
            const filesToProcess = resetUnfinishedRecordings(sessionId);
            
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
        }
        await audioQueue.resume();
    } else {
        console.log("✨ Nessun lavoro in sospeso trovato.");
    }

    startWorker();
});

(async () => {
    await sodium.ready;
    await client.login(process.env.DISCORD_BOT_TOKEN);
})();
