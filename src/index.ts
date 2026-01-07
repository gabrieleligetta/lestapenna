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
import { connectToChannel, disconnect, wipeLocalFiles, pauseRecording, resumeRecording, isRecordingPaused } from './voicerecorder';
import {uploadToOracle, downloadFromOracle, wipeBucket, getPresignedUrl} from './backupService';
import { audioQueue, correctionQueue, removeSessionJobs, clearQueue } from './queue';
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
    getSessionAuthor,
    getUserName,
    getSessionStartTime,
    setSessionNumber,
    getExplicitSessionNumber,
    findSessionByTimestamp,
    getRecording,
    addRecording,
    wipeDatabase,
    getSessionTranscript,
    getGuildConfig,
    setGuildConfig,
    createCampaign,
    getCampaigns,
    getActiveCampaign,
    setActiveCampaign,
    createSession,
    getSessionCampaignId,
    addChatMessage,
    getChatHistory,
    updateSessionTitle,
    db,
    addSessionNote,
    getCampaignCharacters,
    deleteUserCharacter,
    deleteCampaign,
    updateCampaignLocation,
    getCampaignLocation,
    getLocationHistory,
    updateLocation,
    getAtlasEntry,
    updateAtlasEntry,
    getNpcEntry,
    updateNpcEntry,
    listNpcs,
    addQuest,
    updateQuestStatus,
    getOpenQuests,
    addLoot,
    removeLoot,
    getInventory
} from './db';
import { v4 as uuidv4 } from 'uuid';
import { startWorker } from './worker';
import * as path from 'path';
import { monitor, SessionMetrics } from './monitor';
import { processSessionReport, sendTestEmail, sendSessionRecap } from './reporter';
import { exec } from 'child_process';
import { pipeline } from 'stream/promises';

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

const getCmdChannelId = (guildId: string) => getGuildConfig(guildId, 'cmd_channel_id') || process.env.DISCORD_COMMAND_AND_RESPONSE_CHANNEL_ID;
const getSummaryChannelId = (guildId: string) => getGuildConfig(guildId, 'summary_channel_id') || process.env.DISCORD_SUMMARY_CHANNEL_ID;

client.on('messageCreate', async (message: Message) => {
    // CAMBIO PREFISSO: ! -> $
    if (!message.content.startsWith('$') || message.author.bot) return;
    if (!message.guild) return;

    const allowedChannelId = getCmdChannelId(message.guild.id);
    const isConfigCommand = message.content.startsWith('$setcmd');
    
    if (allowedChannelId && message.channelId !== allowedChannelId && !isConfigCommand) return;

    const args = message.content.slice(1).split(' ');
    const command = args.shift()?.toLowerCase();

    // --- COMANDI GESTIONE CAMPAGNE ---

    if (command === 'creacampagna' || command === 'createcampaign') {
        const name = args.join(' ');
        if (!name) return await message.reply("Uso: `$creacampagna <Nome Campagna>`");
        
        createCampaign(message.guild.id, name);
        return await message.reply(`✅ Campagna **${name}** creata! Usa \`$selezionacampagna ${name}\` per attivarla.`);
    }

    if (command === 'listacampagne' || command === 'listcampaigns') {
        const campaigns = getCampaigns(message.guild.id);
        const active = getActiveCampaign(message.guild.id);
        
        if (campaigns.length === 0) {
            return await message.reply("Nessuna campagna trovata. Creane una con `$creacampagna`.");
        }

        const ITEMS_PER_PAGE = 5;
        const totalPages = Math.ceil(campaigns.length / ITEMS_PER_PAGE);
        let currentPage = 0;

        const generateEmbed = (page: number) => {
            const start = page * ITEMS_PER_PAGE;
            const end = start + ITEMS_PER_PAGE;
            const currentCampaigns = campaigns.slice(start, end);

            const list = currentCampaigns.map(c => 
                `${c.id === active?.id ? '👉 ' : ''}**${c.name}** (ID: ${c.id})`
            ).join('\n');

            return new EmbedBuilder()
                .setTitle("🗺️ Campagne di questo Server")
                .setDescription(list)
                .setColor("#E67E22")
                .setFooter({ text: `Pagina ${page + 1} di ${totalPages}` });
        };

        const generateButtons = (page: number) => {
            const row = new ActionRowBuilder<ButtonBuilder>();
            
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId('prev_page_camp')
                    .setLabel('⬅️ Precedente')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('next_page_camp')
                    .setLabel('Successivo ➡️')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages - 1)
            );

            return row;
        };

        const reply = await message.reply({ 
            embeds: [generateEmbed(currentPage)], 
            components: totalPages > 1 ? [generateButtons(currentPage)] : [] 
        });

        if (totalPages > 1) {
            const collector = reply.createMessageComponentCollector({ 
                componentType: ComponentType.Button, 
                time: 60000 
            });

            collector.on('collect', async (interaction: MessageComponentInteraction) => {
                if (interaction.user.id !== message.author.id) {
                    await interaction.reply({ content: "Solo chi ha invocato il comando può sfogliare le pagine.", ephemeral: true });
                    return;
                }

                if (interaction.customId === 'prev_page_camp') {
                    currentPage--;
                } else if (interaction.customId === 'next_page_camp') {
                    currentPage++;
                }

                await interaction.update({ 
                    embeds: [generateEmbed(currentPage)], 
                    components: [generateButtons(currentPage)] 
                });
            });

            collector.on('end', () => {
                reply.edit({ components: [] }).catch(() => {});
            });
        }
    }

    if (command === 'selezionacampagna' || command === 'setcampagna' || command === 'selectcampaign' || command === 'setcampaign') {
        const nameOrId = args.join(' ');
        if (!nameOrId) return await message.reply("Uso: `$selezionacampagna <Nome o ID>`");

        const campaigns = getCampaigns(message.guild.id);
        const target = campaigns.find(c => c.name.toLowerCase() === nameOrId.toLowerCase() || c.id.toString() === nameOrId);

        if (!target) return await message.reply("⚠️ Campagna non trovata.");

        setActiveCampaign(message.guild.id, target.id);
        return await message.reply(`✅ Campagna attiva impostata su: **${target.name}**.`);
    }

    if (command === 'eliminacampagna' || command === 'deletecampaign') {
        const nameOrId = args.join(' ');
        if (!nameOrId) return await message.reply("Uso: `$eliminacampagna <Nome o ID>`");

        const campaigns = getCampaigns(message.guild.id);
        const target = campaigns.find(c => c.name.toLowerCase() === nameOrId.toLowerCase() || c.id.toString() === nameOrId);

        if (!target) return await message.reply("⚠️ Campagna non trovata.");

        // Chiedi conferma
        await message.reply(`⚠️ **ATTENZIONE**: Stai per eliminare la campagna **${target.name}** e TUTTE le sue sessioni, registrazioni e memorie. Questa azione è irreversibile.\nScrivi \`CONFERMO\` per procedere.`);
        
        try {
            const collected = await (message.channel as TextChannel).awaitMessages({
                filter: (m: Message) => m.author.id === message.author.id && m.content === 'CONFERMO',
                max: 1,
                time: 15000,
                errors: ['time']
            });

            if (collected.size > 0) {
                deleteCampaign(target.id);
                await message.reply(`🗑️ Campagna **${target.name}** eliminata definitivamente.`);
            }
        } catch (e) {
            await message.reply("⌛ Tempo scaduto. Eliminazione annullata.");
        }
    }

    // --- CHECK CAMPAGNA ATTIVA ---
    // Molti comandi richiedono una campagna attiva
    const activeCampaign = getActiveCampaign(message.guild.id);
    const campaignCommands = ['ascolta', 'listen', 'sono', 'iam', 'miaclasse', 'myclass', 'miarazza', 'myrace', 'miadesc', 'mydesc', 'chisono', 'whoami', 'listasessioni', 'listsessions', 'chiedialbardo', 'ask', 'ingest', 'memorizza', 'teststream', 'modificatitolo', 'edittitle', 'nota', 'note', 'pausa', 'pause', 'riprendi', 'resume', 'party', 'compagni', 'resetpg', 'clearchara', 'wiki', 'lore', 'luogo', 'location', 'viaggi', 'storia', 'atlante', 'memoria', 'npc', 'dossier', 'presenze', 'quest', 'obiettivi', 'inventario', 'loot', 'bag'];
    
    if (command && campaignCommands.includes(command) && !activeCampaign) {
        return await message.reply("⚠️ **Nessuna campagna attiva!**\nUsa `$creacampagna <Nome>` o `$selezionacampagna <Nome>` prima di iniziare.");
    }

    // --- COMANDO AIUTO (ITALIANO) ---
    if (command === 'aiuto') {
        const helpEmbed = new EmbedBuilder()
            .setTitle("🖋️ Lestapenna - Comandi Disponibili")
            .setColor("#D4AF37")
            .setDescription("Benvenuti, avventurieri! Io sono il vostro bardo e cronista personale.")
            .addFields(
                {
                    name: "🗺️ Campagne",
                    value:
                    "`$creacampagna <Nome>`: Crea nuova campagna.\n" +
                    "`$selezionacampagna <Nome>`: Attiva una campagna.\n" +
                    "`$listacampagne`: Mostra le campagne.\n" +
                    "`$eliminacampagna <Nome>`: Elimina una campagna."
                },
                { 
                    name: "🎙️ Gestione Sessione", 
                    value: 
                    "`$ascolta [Luogo]`: Inizia la registrazione (Campagna Attiva).\n" +
                    "`$termina`: Termina la sessione.\n" +
                    "`$pausa`: Sospende la registrazione.\n" +
                    "`$riprendi`: Riprende la registrazione.\n" +
                    "`$luogo [Macro | Micro]`: Visualizza o aggiorna il luogo attuale.\n" +
                    "`$viaggi`: Mostra la cronologia degli spostamenti.\n" +
                    "`$atlante [Descrizione]`: Visualizza o aggiorna la memoria del luogo.\n" +
                    "`$npc [Nome]`: Visualizza o aggiorna il dossier NPC.\n" +
                    "`$presenze`: Mostra gli NPC incontrati nella sessione corrente.\n" +
                    "`$nota <Testo>`: Aggiunge una nota manuale al riassunto.\n" +
                    "`$impostasessione <N>`: Imposta numero sessione.\n" +
                    "`$impostasessioneid <ID> <N>`: Corregge il numero." 
                },
                { 
                    name: "📜 Narrazione & Archivi", 
                    value: 
                    "`$listasessioni`: Ultime 5 sessioni (Campagna Attiva).\n" +
                    "`$racconta <ID> [tono]`: Rigenera riassunto.\n" +
                    "`$modificatitolo <ID> <Titolo>`: Modifica il titolo di una sessione.\n" +
                    "`$chiedialbardo <Domanda>`: Chiedi al Bardo qualcosa sulla storia.\n" +
                    "`$wiki <Termine>`: Cerca frammenti di lore esatti.\n" +
                    "`$memorizza <ID>`: Indicizza manualmente una sessione nella memoria.\n" +
                    "`$scarica <ID>`: Scarica audio.\n" +
                    "`$scaricatrascrizioni <ID>`: Scarica testo trascrizioni (txt)." 
                },
                {
                    name: "🎒 Inventario & Quest",
                    value:
                    "`$quest`: Visualizza quest attive.\n" +
                    "`$quest add <Titolo>`: Aggiunge una quest.\n" +
                    "`$quest done <Titolo>`: Completa una quest.\n" +
                    "`$inventario`: Visualizza inventario.\n" +
                    "`$loot add <Oggetto>`: Aggiunge un oggetto.\n" +
                    "`$loot use <Oggetto>`: Rimuove/Usa un oggetto."
                },
                { 
                    name: "👤 Scheda Personaggio (Campagna Attiva)", 
                    value: 
                    "`$sono <Nome>`: Imposta il tuo nome.\n" +
                    "`$miaclasse <Classe>`: Imposta la tua classe.\n" +
                    "`$miarazza <Razza>`: Imposta la tua razza.\n" +
                    "`$miadesc <Testo>`: Aggiunge dettagli.\n" +
                    "`$chisono`: Visualizza la tua scheda.\n" +
                    "`$party`: Visualizza tutti i personaggi.\n" +
                    "`$resetpg`: Resetta la tua scheda." 
                },
                { 
                    name: "⚙️ Configurazione & Status", 
                    value: 
                    "`$setcmd`: Imposta questo canale per i comandi.\n" +
                    "`$setsummary`: Imposta questo canale per la pubblicazione dei riassunti.\n" +
                    "`$stato`: Mostra lo stato delle code di elaborazione." 
                },
                {
                    name: "🧪 Test & Debug",
                    value:
                    "`$teststream <URL>`: Simula una sessione scaricando un file audio diretto (mp3/wav).\n" +
                    "`$cleantest`: Rimuove tutte le sessioni di test dal DB."
                }
            )
            .setFooter({ text: "Per la versione inglese usa $help" });
        return await message.reply({ embeds: [helpEmbed] });
    }

    // --- COMANDO HELP (INGLESE) ---
    if (command === 'help') {
        const helpEmbed = new EmbedBuilder()
            .setTitle("🖋️ Lestapenna - Available Commands")
            .setColor("#D4AF37")
            .setDescription("Welcome, adventurers! I am your personal bard and chronicler.")
            .addFields(
                {
                    name: "🗺️ Campaigns",
                    value:
                    "`$createcampaign <Name>`: Create a new campaign.\n" +
                    "`$selectcampaign <Name>`: Activate a campaign.\n" +
                    "`$listcampaigns`: Show available campaigns.\n" +
                    "`$deletecampaign <Name>`: Delete a campaign."
                },
                { 
                    name: "🎙️ Session Management", 
                    value: 
                    "`$listen [Location]`: Start recording (Active Campaign).\n" +
                    "`$stoplistening`: End the session.\n" +
                    "`$pause`: Pause recording.\n" +
                    "`$resume`: Resume recording.\n" +
                    "`$location [Macro | Micro]`: View or update current location.\n" +
                    "`$travels`: Show travel history.\n" +
                    "`$atlas [Description]`: View or update location memory.\n" +
                    "`$npc [Name]`: View or update NPC dossier.\n" +
                    "`$presenze`: Show NPCs encountered in current session.\n" +
                    "`$note <Text>`: Add a manual note to the summary.\n" +
                    "`$setsession <N>`: Manually set session number.\n" +
                    "`$setsessionid <ID> <N>`: Fix session number by ID." 
                },
                { 
                    name: "📜 Storytelling & Archives", 
                    value: 
                    "`$listsessions`: Last 5 sessions (Active Campaign).\n" +
                    "`$narrate <ID> [tone]`: Regenerate summary.\n" +
                    "`$edittitle <ID> <Title>`: Edit session title.\n" +
                    "`$ask <Question>`: Ask the Bard about the lore.\n" +
                    "`$lore <Term>`: Search exact lore fragments.\n" +
                    "`$ingest <ID>`: Manually index a session into memory.\n" +
                    "`$download <ID>`: Download audio.\n" +
                    "`$downloadtxt <ID>`: Download transcriptions (txt)." 
                },
                {
                    name: "🎒 Inventory & Quests",
                    value:
                    "`$quest`: View active quests.\n" +
                    "`$quest add <Title>`: Add a quest.\n" +
                    "`$quest done <Title>`: Complete a quest.\n" +
                    "`$inventory`: View inventory.\n" +
                    "`$loot add <Item>`: Add an item.\n" +
                    "`$loot use <Item>`: Remove/Use an item."
                },
                { 
                    name: "👤 Character Sheet (Active Campaign)", 
                    value: 
                    "`$iam <Name>`: Set your character name.\n" +
                    "`$myclass <Class>`: Set your class.\n" +
                    "`$myrace <Race>`: Set your race.\n" +
                    "`$mydesc <Text>`: Add details.\n" +
                    "`$whoami`: View your current sheet.\n" +
                    "`$party`: View all characters.\n" +
                    "`$clearchara`: Reset your sheet." 
                },
                { 
                    name: "⚙️ Configuration & Status", 
                    value: 
                    "`$setcmd`: Set this channel for commands.\n" +
                    "`$setsummary`: Set this channel for summaries.\n" +
                    "`$status`: Show processing queue status." 
                },
                {
                    name: "🧪 Test & Debug",
                    value:
                    "`$teststream <URL>`: Simulate a session via direct audio link.\n" +
                    "`$cleantest`: Remove all test sessions from DB."
                }
            )
            .setFooter({ text: "Per la versione italiana usa $aiuto" });
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
        
        // --- NUOVO BLOCCO GESTIONE LUOGO ---
        const locationArg = args.join(' '); // Prende tutto quello che scrivi dopo !ascolta
        
        const sessionId = uuidv4(); // Generiamo subito l'ID per passarlo a updateLocation

        if (locationArg) {
            // Se il DM ha specificato un luogo, lo aggiorniamo subito
            // Supporto sintassi Macro | Micro
            let newMacro = null;
            let newMicro = null;

            if (locationArg.includes('|')) {
                const parts = locationArg.split('|').map(s => s.trim());
                newMacro = parts[0];
                newMicro = parts[1];
            } else {
                // Sintassi semplice: assume sia un cambio di Micro-luogo (stanza/edificio)
                newMicro = locationArg.trim();
            }
            
            updateLocation(activeCampaign!.id, newMacro, newMicro, sessionId);
            await message.reply(`📍 Posizione tracciata: **${newMacro || '-'}** | **${newMicro || '-'}**.\nIl Bardo userà questo contesto per le trascrizioni.`);
        } else {
            // Altrimenti controlliamo se c'è un luogo in memoria
            const currentLoc = getCampaignLocation(message.guild.id);
            if (currentLoc && (currentLoc.macro || currentLoc.micro)) {
                await message.reply(`📍 Luogo attuale: **${currentLoc.macro || '-'}** | **${currentLoc.micro || '-'}** (Se è cambiato, usa \`$ascolta Macro | Micro\`)`);
            } else {
                await message.reply(`⚠️ **Luogo Sconosciuto.**\nConsiglio: scrivi \`$ascolta <Città> | <Luogo>\` per aiutare il Bardo a capire meglio i nomi e l'atmosfera.`);
            }
        }
        // -----------------------------------

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
                    missingNames.map(n => `- **${n}** (Usa: \`$sono NomePersonaggio\`)`).join('\n')
                );
            }
            
            if (botMembers.size > 0) {
                const botNames = botMembers.map(b => b.displayName).join(', ');
                await (message.channel as TextChannel).send(`🤖 Noto la presenza di costrutti magici (${botNames}). Le loro voci saranno ignorate.`);
            }

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
    if (command === 'stoplistening' || command === 'termina') {
        const sessionId = guildSessions.get(message.guild.id);
        if (!sessionId) {
            await disconnect(message.guild.id);
            await message.reply("Nessuna sessione attiva tracciata, ma mi sono disconnesso.");
            return;
        }

        // 1. Disconnessione e chiusura file
        await disconnect(message.guild.id);
        guildSessions.delete(message.guild.id);

        await message.reply(`🛑 Sessione **${sessionId}** terminata. Lo Scriba sta trascrivendo...`);
        
        // 2. Ripresa coda
        await audioQueue.resume();
        console.log(`[Flow] Coda RIPRESA. I worker stanno elaborando i file accumulati...`);

        // 3. Monitoraggio
        await waitForCompletionAndSummarize(sessionId, message.channel as TextChannel);
    }

    // --- NUOVO: !pausa / !riprendi ---
    if (command === 'pausa' || command === 'pause') {
        const sessionId = guildSessions.get(message.guild.id);
        if (!sessionId) return await message.reply("Nessuna sessione attiva.");
        
        if (isRecordingPaused(message.guild.id)) {
            return await message.reply("La registrazione è già in pausa.");
        }

        pauseRecording(message.guild.id);
        await message.reply("⏸️ **Registrazione in Pausa**. Il Bardo si riposa.");
    }

    if (command === 'riprendi' || command === 'resume') {
        const sessionId = guildSessions.get(message.guild.id);
        if (!sessionId) return await message.reply("Nessuna sessione attiva.");

        if (!isRecordingPaused(message.guild.id)) {
            return await message.reply("La registrazione è già attiva.");
        }

        resumeRecording(message.guild.id);
        await message.reply("▶️ **Registrazione Ripresa**. Il Bardo torna ad ascoltare.");
    }

    // --- NUOVO: !nota <Testo> ---
    if (command === 'nota' || command === 'note') {
        const sessionId = guildSessions.get(message.guild.id);
        if (!sessionId) return await message.reply("⚠️ Nessuna sessione attiva. Avvia prima una sessione con `$ascolta`.");

        const noteContent = args.join(' ');
        if (!noteContent) return await message.reply("Uso: `$nota <Testo della nota>`");

        addSessionNote(sessionId, message.author.id, noteContent, Date.now());
        await message.reply("📝 Nota aggiunta al diario della sessione.");
    }

    // --- NUOVO: !luogo <Macro | Micro> ---
    if (command === 'luogo' || command === 'location') {
        const argsStr = args.join(' ');
        
        if (!argsStr) {
            // Getter
            const loc = getCampaignLocation(message.guild.id);
            if (!loc || (!loc.macro && !loc.micro)) {
                return message.reply("🗺️ Non so dove siete! Usa `$luogo <Città> | <Luogo>` per impostarlo.");
            }
            return message.reply(`📍 **Posizione Attuale**\n🌍 Regione: **${loc.macro || "Sconosciuto"}**\n🏠 Luogo: **${loc.micro || "Generico"}**`);
        } else {
            // Setter
            const current = getCampaignLocation(message.guild.id);
            const sessionId = guildSessions.get(message.guild.id); // Recupera sessione attiva se c'è
            
            let newMacro = current?.macro || null;
            let newMicro = null;

            if (argsStr.includes('|')) {
                // Sintassi esplicita: Macro | Micro
                const parts = argsStr.split('|').map(s => s.trim());
                newMacro = parts[0];
                newMicro = parts[1];
            } else {
                // Sintassi semplice: assume sia un cambio di Micro-luogo (stanza/edificio)
                newMicro = argsStr.trim();
            }

            updateLocation(activeCampaign!.id, newMacro, newMicro, sessionId);
            
            return message.reply(`📍 **Aggiornamento Manuale**\nImpostato su: ${newMacro || '-'} | ${newMicro || '-'}`);
        }
    }

    // --- NUOVO: !viaggi (Cronologia) ---
    if (command === 'viaggi' || command === 'storia' || command === 'travels') {
        const history = getLocationHistory(message.guild.id);
        
        if (history.length === 0) return message.reply("Il diario di viaggio è vuoto.");

        let msg = "**📜 Diario di Viaggio (Ultimi spostamenti):**\n";
        
        // Raggruppamento semplice
        history.forEach((h: any) => {
            const time = new Date(h.timestamp).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
            msg += `\`${h.session_date} ${time}\` 🌍 **${h.macro_location || '-'}** 👉 🏠 ${h.micro_location || 'Esterno'}\n`;
        });

        return message.reply(msg);
    }

    // --- NUOVO: !atlante (Memoria Luoghi) ---
    if (command === 'atlante' || command === 'memoria' || command === 'atlas') {
        const loc = getCampaignLocation(message.guild.id);
        
        if (!loc || !loc.macro || !loc.micro) {
            return message.reply("⚠️ Non so dove siete. Imposta prima il luogo con `$luogo`.");
        }

        const newDesc = args.join(' ');
        
        if (newDesc) {
            // SETTER MANUALE
            updateAtlasEntry(activeCampaign!.id, loc.macro, loc.micro, newDesc);
            return message.reply(`📖 **Atlante Aggiornato** per *${loc.micro}*:\n"${newDesc}"`);
        } else {
            // GETTER
            const lore = getAtlasEntry(activeCampaign!.id, loc.macro, loc.micro);
            if (lore) {
                return message.reply(`📖 **Atlante: ${loc.macro} - ${loc.micro}**\n\n_${lore}_`);
            } else {
                return message.reply(`📖 **Atlante: ${loc.macro} - ${loc.micro}**\n\n*Nessuna memoria registrata per questo luogo.*`);
            }
        }
    }

    // --- COMANDO: $npc (Visualizza o Modifica) ---
    // Uso: $npc -> Lista ultimi NPC
    // Uso: $npc Mario -> Vedi scheda di Mario
    // Uso: $npc Mario | È un bravo idraulico -> Aggiorna descrizione
    if (command === 'npc' || command === 'dossier') {
        const argsStr = args.join(' ');
        
        if (!argsStr) {
            // LISTA
            const npcs = listNpcs(activeCampaign!.id);
            if (npcs.length === 0) return message.reply("L'archivio NPC è vuoto.");
            
            const list = npcs.map((n: any) => `👤 **${n.name}** (${n.role || '?'}) [${n.status}]`).join('\n');
            return message.reply(`**📂 Dossier NPC Recenti**\n${list}`);
        }

        if (argsStr.includes('|')) {
            // SETTER: $npc Nome | Descrizione
            const [name, desc] = argsStr.split('|').map(s => s.trim());
            updateNpcEntry(activeCampaign!.id, name, desc);
            return message.reply(`👤 Scheda di **${name}** aggiornata.`);
        } else {
            // GETTER: $npc Nome
            const npc = getNpcEntry(activeCampaign!.id, argsStr);
            if (!npc) return message.reply("NPC non trovato.");
            
            const embed = new EmbedBuilder()
                .setTitle(`👤 Dossier: ${npc.name}`)
                .setColor(npc.status === 'DEAD' ? "#FF0000" : "#00FF00")
                .addFields(
                    { name: "Ruolo", value: npc.role || "Sconosciuto", inline: true },
                    { name: "Stato", value: npc.status || "Vivo", inline: true },
                    { name: "Note", value: npc.description || "Nessuna nota." }
                )
                .setFooter({ text: `Ultimo avvistamento: ${npc.last_updated}` });
            
            return message.reply({ embeds: [embed] });
        }
    }

    // --- NUOVO: $presenze (Debug) ---
    if (command === 'presenze') {
        const sessionId = guildSessions.get(message.guild.id);
        if (!sessionId) return await message.reply("⚠️ Nessuna sessione attiva.");

        // Recupera tutti gli NPC univoci visti nelle registrazioni della sessione
        const rows = db.prepare(`
            SELECT DISTINCT present_npcs 
            FROM recordings 
            WHERE session_id = ? AND present_npcs IS NOT NULL
        `).all(sessionId) as { present_npcs: string }[];
        
        // Unisci e pulisci le stringhe (es. "Grog,Mario" e "Mario,Luigi")
        const allNpcs = new Set<string>();
        rows.forEach(r => r.present_npcs.split(',').forEach(n => {
            const trimmed = n.trim();
            if (trimmed) allNpcs.add(trimmed);
        }));
        
        if (allNpcs.size === 0) {
            return message.reply(`👥 **NPC Incontrati:** Nessuno rilevato finora.`);
        }

        return message.reply(`👥 **NPC Incontrati in questa sessione:**\n${Array.from(allNpcs).join(', ')}`);
    }

    // --- NUOVO: $quest ---
    if (command === 'quest' || command === 'obiettivi') {
        const arg = args.join(' ');

        // Sottocomandi manuali: $quest add Titolo / $quest done Titolo
        if (arg.toLowerCase().startsWith('add ')) {
            const title = arg.substring(4);
            addQuest(activeCampaign!.id, title);
            return message.reply(`🗺️ Quest aggiunta: **${title}**`);
        }
        if (arg.toLowerCase().startsWith('done ') || arg.toLowerCase().startsWith('completata ')) {
            const search = arg.split(' ').slice(1).join(' '); // Rimuove 'done'
            updateQuestStatus(activeCampaign!.id, search, 'COMPLETED');
            return message.reply(`✅ Quest aggiornata come completata (ricerca: "${search}")`);
        }

        // Visualizzazione
        const quests = getOpenQuests(activeCampaign!.id);
        if (quests.length === 0) return message.reply("Nessuna quest attiva al momento.");

        const list = quests.map((q: any) => `🔹 **${q.title}**`).join('\n');
        return message.reply(`**🗺️ Quest Attive (${activeCampaign?.name})**\n\n${list}`);
    }

    // --- NUOVO: $inventario ---
    if (command === 'inventario' || command === 'loot' || command === 'bag' || command === 'inventory') {
        const arg = args.join(' ');

        // Sottocomandi manuali: $loot add Pozione / $loot use Pozione
        if (arg.toLowerCase().startsWith('add ')) {
            const item = arg.substring(4);
            addLoot(activeCampaign!.id, item, 1);
            return message.reply(`💰 Aggiunto: **${item}**`);
        }
        if (arg.toLowerCase().startsWith('use ') || arg.toLowerCase().startsWith('usa ') || arg.toLowerCase().startsWith('remove ')) {
            const item = arg.split(' ').slice(1).join(' ');
            const removed = removeLoot(activeCampaign!.id, item, 1);
            if (removed) return message.reply(`📉 Rimosso/Usato: **${item}**`);
            else return message.reply(`⚠️ Oggetto "${item}" non trovato nell'inventario.`);
        }

        // Visualizzazione
        const items = getInventory(activeCampaign!.id);
        if (items.length === 0) return message.reply("Lo zaino è vuoto.");

        const list = items.map((i: any) => `📦 **${i.item_name}** ${i.quantity > 1 ? `(x${i.quantity})` : ''}`).join('\n');
        return message.reply(`**💰 Inventario di Gruppo (${activeCampaign?.name})**\n\n${list}`);
    }

    // --- NUOVO: !stato ---
    if (command === 'stato' || command === 'status') {
        const audioCounts = await audioQueue.getJobCounts();
        const correctionCounts = await correctionQueue.getJobCounts();
        
        const embed = new EmbedBuilder()
            .setTitle("⚙️ Stato del Sistema")
            .setColor("#2ECC71")
            .addFields(
                { name: "🎙️ Coda Audio", value: `In attesa: ${audioCounts.waiting}\nAttivi: ${audioCounts.active}\nCompletati: ${audioCounts.completed}\nFalliti: ${audioCounts.failed}`, inline: true },
                { name: "🧠 Coda Correzione", value: `In attesa: ${correctionCounts.waiting}\nAttivi: ${correctionCounts.active}\nCompletati: ${correctionCounts.completed}\nFalliti: ${correctionCounts.failed}`, inline: true }
            )
            .setTimestamp();
        
        await message.reply({ embeds: [embed] });
    }

    // --- NUOVO: !setsession <numero> ---
    if (command === 'setsession' || command === 'impostasessione') {
        const sessionId = guildSessions.get(message.guild.id);
        if (!sessionId) {
            return await message.reply("⚠️ Nessuna sessione attiva. Avvia prima una sessione con `$ascolta`.");
        }

        const sessionNum = parseInt(args[0]);
        if (isNaN(sessionNum) || sessionNum <= 0) {
            return await message.reply("Uso: `$impostasessione <numero>` (es. `$impostasessione 5`)");
        }

        setSessionNumber(sessionId, sessionNum);
        await message.reply(`✅ Numero sessione impostato a **${sessionNum}**. Sarà usato per il prossimo riassunto.`);
    }

    // --- NUOVO: !setsessionid <id_sessione> <numero> ---
    if (command === 'setsessionid' || command === 'impostasessioneid') {
        const targetSessionId = args[0];
        const sessionNum = parseInt(args[1]);

        if (!targetSessionId || isNaN(sessionNum)) {
            return await message.reply("Uso: `$impostasessioneid <ID_SESSIONE> <NUMERO>`");
        }

        setSessionNumber(targetSessionId, sessionNum);
        await message.reply(`✅ Numero sessione per \`${targetSessionId}\` impostato a **${sessionNum}**.`);
    }

    // --- NUOVO: !reset <id_sessione> ---
    if (command === 'reset') {
        const targetSessionId = args[0];
        if (!targetSessionId) {
            return await message.reply("Uso: `$reset <ID_SESSIONE>` - Forza la rielaborazione completa.");
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
            return await message.reply("Uso: `$scaricatrascrizioni <ID>`");
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
    if (command === 'racconta' || command === 'narrate' || command === 'summarize') {
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
        
        // FASE 1: INGESTIONE (Opzionale ma consigliata)
        try {
            await channel.send("🧠 Il Bardo sta studiando gli eventi per ricordarli in futuro...");
            await ingestSessionRaw(targetSessionId);
            await channel.send("✅ Memoria aggiornata.");
        } catch (ingestErr: any) {
            console.error(`⚠️ Errore ingestione ${targetSessionId}:`, ingestErr);
            await channel.send(`⚠️ Ingestione memoria fallita: ${ingestErr.message}. Puoi riprovare più tardi con \`$memorizza ${targetSessionId}\`.`);
            // Non blocchiamo il riassunto
        }

        // FASE 2: RIASSUNTO
        try {
            await channel.send("✍️ Inizio stesura del racconto...");
            const result = await generateSummary(targetSessionId, requestedTone || 'DM');
            
            // SALVATAGGIO TITOLO
            updateSessionTitle(targetSessionId, result.title);

            // --- AUTOMAZIONE DB: LOOT & QUEST ---
            const activeCampaignId = activeCampaign!.id;

            if (result.loot && result.loot.length > 0) {
                result.loot.forEach((item: string) => addLoot(activeCampaignId, item));
            }

            if (result.loot_removed && result.loot_removed.length > 0) {
                result.loot_removed.forEach((item: string) => removeLoot(activeCampaignId, item));
            }

            if (result.quests && result.quests.length > 0) {
                result.quests.forEach((q: string) => addQuest(activeCampaignId, q));
            }
            // ------------------------------------

            await publishSummary(targetSessionId, result.summary, channel, true, result.title, result.loot, result.quests, result.narrative);

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

    // --- NUOVO: !modificatitolo <ID> <Titolo> ---
    if (command === 'modificatitolo' || command === 'edittitle') {
        const targetSessionId = args[0];
        const newTitle = args.slice(1).join(' ');

        if (!targetSessionId || !newTitle) {
            return await message.reply("Uso: `$modificatitolo <ID_SESSIONE> <Nuovo Titolo>`");
        }

        updateSessionTitle(targetSessionId, newTitle);
        await message.reply(`✅ Titolo aggiornato per la sessione \`${targetSessionId}\`: **${newTitle}**`);
    }

    // --- NUOVO: !chiedialbardo <Domanda> ---
    if (command === 'chiedialbardo' || command === 'ask') {
        const question = args.join(' ');
        if (!question) return await message.reply("Uso: `$chiedialbardo <Domanda>`");

        // Fix per TS2339: Controllo se il canale supporta sendTyping
        if ('sendTyping' in message.channel) {
            await (message.channel as TextChannel | DMChannel | NewsChannel | ThreadChannel).sendTyping();
        }

        try {
            // GESTIONE MEMORIA PERSISTENTE
            const history = getChatHistory(message.channelId, 6); // Recupera ultimi 6 messaggi (3 scambi)
            const answer = await askBard(activeCampaign!.id, question, history);
            
            // Salva nel DB
            addChatMessage(message.channelId, 'user', question);
            addChatMessage(message.channelId, 'assistant', answer);

            await message.reply(answer);
        } catch (err) {
            console.error("Errore chiedialbardo:", err);
            await message.reply("Il Bardo ha un vuoto di memoria...");
        }
    }

    // --- NUOVO: !wiki <Termine> ---
    if (command === 'wiki' || command === 'lore') {
        const term = args.join(' ');
        if (!term) return await message.reply("Uso: `$wiki <Termine>`");

        // Fix per TS2339: Controllo se il canale supporta sendTyping
        if ('sendTyping' in message.channel) {
            await (message.channel as TextChannel | DMChannel | NewsChannel | ThreadChannel).sendTyping();
        }

        try {
            // Usa searchKnowledge ma restituisce i risultati raw
            const { searchKnowledge } = require('./bard'); // Import dinamico per evitare cicli se necessario, o usa import statico
            const fragments = await searchKnowledge(activeCampaign!.id, term, 3);
            
            if (fragments.length === 0) {
                return await message.reply("Non ho trovato nulla negli archivi su questo argomento.");
            }

            const embed = new EmbedBuilder()
                .setTitle(`📚 Archivi: ${term}`)
                .setColor("#F1C40F")
                .setDescription(fragments.map((f: string, i: number) => `**Frammento ${i+1}:**\n${f}`).join('\n\n'));

            await message.reply({ embeds: [embed] });
        } catch (err) {
            console.error("Errore wiki:", err);
            await message.reply("Errore durante la consultazione degli archivi.");
        }
    }

    // --- NUOVO: !ingest <session_id> ---
    if (command === 'ingest' || command === 'memorizza') {
        const targetSessionId = args[0];
        if (!targetSessionId) return await message.reply("Uso: `$ingest <ID_SESSIONE>`");

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
            return await message.reply("⚠️ Specifica un ID sessione o avvia una sessione: `$scarica <ID>`");
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
    if (command === 'listasessioni' || command === 'listsessions') {
        const sessions = getAvailableSessions(message.guild.id, activeCampaign?.id, 0); // 0 = No limit
        if (sessions.length === 0) {
            await message.reply("Nessuna sessione trovata negli archivi per questa campagna.");
        } else {
            const ITEMS_PER_PAGE = 5;
            const totalPages = Math.ceil(sessions.length / ITEMS_PER_PAGE);
            let currentPage = 0;

            const generateEmbed = (page: number) => {
                const start = page * ITEMS_PER_PAGE;
                const end = start + ITEMS_PER_PAGE;
                const currentSessions = sessions.slice(start, end);

                const list = currentSessions.map(s => {
                    const title = s.title ? `📜 **${s.title}**` : "";
                    return `🆔 \`${s.session_id}\`\n📅 ${new Date(s.start_time).toLocaleString()} (${s.fragments} frammenti)\n${title}`;
                }).join('\n\n');

                return new EmbedBuilder()
                    .setTitle(`📜 Cronache: ${activeCampaign?.name}`)
                    .setColor("#7289DA")
                    .setDescription(list)
                    .setFooter({ text: `Pagina ${page + 1} di ${totalPages}` });
            };

            const generateButtons = (page: number) => {
                const row = new ActionRowBuilder<ButtonBuilder>();
                
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId('prev_page')
                        .setLabel('⬅️ Precedente')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === 0),
                    new ButtonBuilder()
                        .setCustomId('next_page')
                        .setLabel('Successivo ➡️')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === totalPages - 1)
                );

                return row;
            };

            const reply = await message.reply({ 
                embeds: [generateEmbed(currentPage)], 
                components: totalPages > 1 ? [generateButtons(currentPage)] : [] 
            });

            if (totalPages > 1) {
                const collector = reply.createMessageComponentCollector({ 
                    componentType: ComponentType.Button, 
                    time: 60000 
                });

                collector.on('collect', async (interaction: MessageComponentInteraction) => {
                    if (interaction.user.id !== message.author.id) {
                        await interaction.reply({ content: "Solo chi ha invocato il comando può sfogliare le pagine.", ephemeral: true });
                        return;
                    }

                    if (interaction.customId === 'prev_page') {
                        currentPage--;
                    } else if (interaction.customId === 'next_page') {
                        currentPage++;
                    }

                    await interaction.update({ 
                        embeds: [generateEmbed(currentPage)], 
                        components: [generateButtons(currentPage)] 
                    });
                });

                collector.on('end', () => {
                    reply.edit({ components: [] }).catch(() => {});
                });
            }
        }
    }

    // --- NUOVO: !toni ---
    if (command === 'toni' || command === 'tones') {
        const embed = new EmbedBuilder()
            .setTitle("🎭 Toni Narrativi")
            .setColor("#9B59B6")
            .setDescription("Scegli come deve essere raccontata la tua storia:")
            .addFields(Object.entries(TONES).map(([key, desc]) => ({ name: key, value: desc })));
        
        await message.reply({ embeds: [embed] });
    }

    // --- MODIFICATO: !teststream <URL> ---
    if (command === 'teststream') {
        const url = args[0];
        if (!url) return await message.reply("Uso: `$teststream <URL>` (es. YouTube o link diretto mp3)");

        const sessionId = `test-direct-${uuidv4().substring(0, 8)}`;
        
        // Crea sessione di test
        createSession(sessionId, message.guild.id, activeCampaign!.id);
        monitor.startSession(sessionId);
        
        await message.reply(`🧪 **Test Stream Avviato**\nID Sessione: \`${sessionId}\`\nAnalisi del link in corso...`);

        const recordingsDir = path.join(__dirname, '..', 'recordings');
        if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

        // Nome file temporaneo
        const tempFileName = `${message.author.id}-${Date.now()}.mp3`;
        const tempFilePath = path.join(recordingsDir, tempFileName);

        try {
            // RILEVAMENTO YOUTUBE (Regex base per domini YT)
            const isYouTube = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\/.+$/.test(url);

            if (isYouTube) {
                // --- LOGICA YOUTUBE (yt-dlp) ---
                await (message.channel as TextChannel).send("🎥 Link YouTube rilevato. Avvio download con yt-dlp...");

                // Cerchiamo i cookies nella root (come in player.js)
                const cookiesPath = path.resolve(__dirname, '..', 'cookies.json');
                let cookieArg = '';
                
                if (fs.existsSync(cookiesPath)) {
                    const stats = fs.statSync(cookiesPath);
                    if (stats.isFile() && stats.size > 0) {
                        cookieArg = ` --cookies "${cookiesPath}"`;
                        console.log("[TestStream] Cookies trovati e utilizzati per il download.");
                    }
                }

                // Costruzione comando: Estrae audio, converte in mp3, forza output sul file target
                // Nota: Assicurati che 'yt-dlp' sia installato e nel PATH
                const cmd = `yt-dlp -x --audio-format mp3 --output "${tempFilePath}"${cookieArg} "${url}"`;

                // Esecuzione tramite promise manuale (senza aggiungere import 'util')
                await new Promise<void>((resolve, reject) => {
                    exec(cmd, (error, stdout, stderr) => {
                        if (error) {
                            console.error(`[yt-dlp error] ${stderr}`);
                            reject(error);
                        } else {
                            console.log(`[yt-dlp output] ${stdout}`);
                            resolve();
                        }
                    });
                });

                console.log(`[TestStream] Download YouTube completato: ${tempFilePath}`);

            } else {
                // --- LOGICA LINK DIRETTO (Vecchia logica con fix Content-Type) ---
                await (message.channel as TextChannel).send("🔗 Link diretto rilevato. Scarico file...");

                const response = await fetch(url);
                if (!response.ok) throw new Error(`Errore HTTP: ${response.statusText}`);
                
                // Controllo Content-Type per evitare di scaricare HTML
                const contentType = response.headers.get('content-type');
                if (contentType && !contentType.startsWith('audio/') && !contentType.includes('octet-stream')) {
                     throw new Error(`Il link non è un file audio valido (Rilevato: ${contentType}). Usa un link diretto o YouTube.`);
                }

                if (!response.body) throw new Error("Nessun contenuto ricevuto");

                await pipeline(response.body, fs.createWriteStream(tempFilePath));
                console.log(`[TestStream] Download diretto completato: ${tempFilePath}`);
            }
            
            // --- PROCEDURA STANDARD (Uguale a prima) ---
            // Registra nel DB come se fosse un file vocale
            addRecording(sessionId, tempFileName, tempFilePath, message.author.id, Date.now());
            
            // Upload su Oracle (simulato o reale)
            try {
                const uploaded = await uploadToOracle(tempFilePath, tempFileName, sessionId);
                if (uploaded) {
                    updateRecordingStatus(tempFileName, 'SECURED');
                }
            } catch (e) {
                console.error("[TestStream] Errore upload:", e);
            }

            // Accoda per trascrizione
            await audioQueue.add('transcribe-job', {
                sessionId: sessionId,
                fileName: tempFileName,
                filePath: tempFilePath,
                userId: message.author.id
            }, {
                jobId: tempFileName,
                attempts: 3,
                removeOnComplete: true
            });

            await message.reply(`✅ Audio scaricato e accodato. Attendi la trascrizione e il riassunto...`);
            
            // Avvia monitoraggio per riassunto automatico
            await waitForCompletionAndSummarize(sessionId, message.channel as TextChannel);

        } catch (error: any) {
            console.error(`[TestStream] Errore: ${error.message}`);
            await message.reply(`❌ Errore durante il processo: ${error.message}`);
            // Pulizia file parziale se esiste
            if (fs.existsSync(tempFilePath)) {
                try { fs.unlinkSync(tempFilePath); } catch(e) {}
            }
        }
    }

    // --- NUOVO: !cleantest ---
    if (command === 'cleantest') {
        if (!message.member?.permissions.has('Administrator')) return;

        await message.reply("🧹 Pulizia sessioni di test (ID che iniziano con `test-`)...");

        // 1. Trova sessioni di test
        const testSessions = db.prepare("SELECT session_id FROM sessions WHERE session_id LIKE 'test-%'").all() as { session_id: string }[];
        
        if (testSessions.length === 0) {
            return await message.reply("✅ Nessuna sessione di test trovata.");
        }

        let deletedCount = 0;
        for (const s of testSessions) {
            // Rimuovi job dalla coda
            await removeSessionJobs(s.session_id);
            
            // Rimuovi file dal DB (recordings, knowledge, session)
            db.prepare("DELETE FROM recordings WHERE session_id = ?").run(s.session_id);
            db.prepare("DELETE FROM knowledge_fragments WHERE session_id = ?").run(s.session_id);
            db.prepare("DELETE FROM sessions WHERE session_id = ?").run(s.session_id);
            
            deletedCount++;
        }

        await message.reply(`✅ Eliminate **${deletedCount}** sessioni di test dal database.`);
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
        } else await message.reply("Uso: `$sono Nome`");
    }

    if (command === 'myclass' || command === 'miaclasse') {
        const val = args.join(' ');
        if (val) {
            updateUserCharacter(message.author.id, activeCampaign!.id, 'class', val);
            await message.reply(`🛡️ Classe aggiornata: **${val}**`);
        } else await message.reply("Uso: `$miaclasse Barbaro / Mago / Ladro...`");
    }

    if (command === 'myrace' || command === 'miarazza') {
        const val = args.join(' ');
        if (val) {
            updateUserCharacter(message.author.id, activeCampaign!.id, 'race', val);
            await message.reply(`🧬 Razza aggiornata: **${val}**`);
        } else await message.reply("Uso: `$miarazza Umano / Elfo / Nano...`");
    }

    if (command === 'mydesc' || command === 'miadesc') {
        const val = args.join(' ');
        if (val) {
            updateUserCharacter(message.author.id, activeCampaign!.id, 'description', val);
            await message.reply(`📜 Descrizione aggiornata! Il Bardo prenderà nota.`);
        } else await message.reply("Uso: `$miadesc Breve descrizione del carattere o aspetto`");
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
            await message.reply("Non ti conosco in questa campagna. Usa `$sono <Nome>` per iniziare la tua leggenda!");
        }
    }

    // --- NUOVO: !party ---
    if (command === 'party' || command === 'compagni') {
        const characters = getCampaignCharacters(activeCampaign!.id);
        
        if (characters.length === 0) {
            return await message.reply("Nessun avventuriero registrato in questa campagna.");
        }

        const list = characters.map(c => {
            const name = c.character_name || "Sconosciuto";
            const details = [c.race, c.class].filter(Boolean).join(' - ');
            return `**${name}**${details ? ` (${details})` : ''}`;
        }).join('\n');

        const embed = new EmbedBuilder()
            .setTitle(`🛡️ Party: ${activeCampaign!.name}`)
            .setColor("#9B59B6")
            .setDescription(list);

        await message.reply({ embeds: [embed] });
    }

    // --- NUOVO: !resetpg ---
    if (command === 'resetpg' || command === 'clearchara') {
        deleteUserCharacter(message.author.id, activeCampaign!.id);
        await message.reply("🗑️ Scheda personaggio resettata. Ora sei un'anima errante.");
    }
});

// --- FUNZIONE MONITORAGGIO CODA ---
async function waitForCompletionAndSummarize(sessionId: string, discordChannel: TextChannel) {
    console.log(`[Monitor] Avviato monitoraggio per sessione ${sessionId}...`);
    
    // Attesa iniziale per permettere ai file di essere accodati
    await new Promise(resolve => setTimeout(resolve, 5000));

    const checkInterval = setInterval(async () => {
        const audioJobs = await audioQueue.getJobs(['waiting', 'active', 'delayed']);
        const correctionJobs = await correctionQueue.getJobs(['waiting', 'active', 'delayed']);
        
        const sessionAudioJobs = audioJobs.filter(j => !!j && j.data && j.data.sessionId === sessionId);
        const sessionCorrectionJobs = correctionJobs.filter(j => !!j && j.data && j.data.sessionId === sessionId);
        
        const totalPending = sessionAudioJobs.length + sessionCorrectionJobs.length;

        if (totalPending > 0) {
             const details = [];
             if (sessionAudioJobs.length > 0) details.push(`${sessionAudioJobs.length} audio`);
             if (sessionCorrectionJobs.length > 0) details.push(`${sessionCorrectionJobs.length} correction`);
             
            console.log(`[Monitor] Sessione ${sessionId}: ancora ${totalPending} file... (${details.join(', ')})`);
        } else {
            clearInterval(checkInterval);
            console.log(`✅ Sessione ${sessionId}: Tutti i file processati. Generazione Riassunto...`);
            
            const startSummary = Date.now();
            
            // FASE 1: INGESTIONE (Separata)
            try {
                await discordChannel.send("🧠 Il Bardo sta studiando gli eventi per ricordarli in futuro...");
                await ingestSessionRaw(sessionId);
                await discordChannel.send("✅ Memoria aggiornata.");
            } catch (ingestErr: any) {
                console.error(`⚠️ Errore ingestione ${sessionId}:`, ingestErr);
                await discordChannel.send(`⚠️ Ingestione memoria fallita: ${ingestErr.message}. Puoi riprovare più tardi con \`$memorizza ${sessionId}\`.`);
                // Non blocchiamo il riassunto
            }

            // FASE 2: RIASSUNTO
            try {
                await discordChannel.send("✍️ Inizio stesura del racconto...");
                const result = await generateSummary(sessionId, 'DM');
                
                // SALVATAGGIO TITOLO
                updateSessionTitle(sessionId, result.title);

                // --- AUTOMAZIONE DB: LOOT & QUEST ---
                const activeCampaignId = getSessionCampaignId(sessionId);
                if (activeCampaignId) {
                    if (result.loot && result.loot.length > 0) {
                        result.loot.forEach((item: string) => addLoot(activeCampaignId, item));
                    }
                    
                    if (result.loot_removed && result.loot_removed.length > 0) {
                        result.loot_removed.forEach((item: string) => removeLoot(activeCampaignId, item));
                    }

                    if (result.quests && result.quests.length > 0) {
                        result.quests.forEach((q: string) => addQuest(activeCampaignId, q));
                    }
                }
                // ------------------------------------

                monitor.logSummarizationTime(Date.now() - startSummary);
                monitor.logTokenUsage(result.tokens);

                await publishSummary(sessionId, result.summary, discordChannel, false, result.title, result.loot, result.quests, result.narrative);
                
                // --- INVIO EMAIL DM ---
                if (activeCampaignId) {
                    // Inviamo l'email in background senza bloccare il bot
                    sendSessionRecap(
                        sessionId, 
                        activeCampaignId, 
                        result.summary, 
                        result.loot, 
                        result.loot_removed,
                        result.narrative // NUOVO PARAMETRO
                    ).catch(e => console.error("Errore async email:", e));
                    
                    await discordChannel.send("📧 Ho inviato una pergamena (email) di riepilogo al Dungeon Master.");
                }
                // ---------------------

            } catch (err: any) {
                console.error(`❌ Errore riassunto finale ${sessionId}:`, err);
                monitor.logError('Summary', err.message);
                await discordChannel.send(`⚠️ Errore riassunto. Riprova: \`$racconta ${sessionId}\`.`);
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

async function publishSummary(sessionId: string, summary: string, defaultChannel: TextChannel, isReplay: boolean = false, title?: string, loot?: string[], quests?: string[], narrative?: string) {
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

    await targetChannel.send(`\`\`\`diff\n${header}\n\`\`\``);
    
    if (title) {
        await targetChannel.send(`## 📜 ${title}`);
    }

    await targetChannel.send(`**${authorName}** — ${dateShort}, ${timeStr}`);

    // --- NUOVO: RACCONTO NARRATIVO ---
    if (narrative && narrative.length > 10) {
        await targetChannel.send(`### 📖 Racconto`);
        const narrativeChunks = narrative.match(/[\s\S]{1,1900}/g) || [];
        for (const chunk of narrativeChunks) {
            await targetChannel.send(chunk);
        }
        await targetChannel.send(`---\n`); // Separatore
    }
    // ---------------------------------

    const chunks = summary.match(/[\s\S]{1,1900}/g) || [];
    for (const chunk of chunks) {
        await targetChannel.send(chunk);
    }

    // --- VISUALIZZAZIONE LOOT & QUEST ---
    if ((loot && loot.length > 0) || (quests && quests.length > 0)) {
        const embed = new EmbedBuilder()
            .setColor("#F1C40F")
            .setTitle("🎒 Riepilogo Tecnico");
        
        if (loot && loot.length > 0) {
            embed.addFields({ name: "💰 Bottino (Loot)", value: loot.map(i => `• ${i}`).join('\n') });
        }
        
        if (quests && quests.length > 0) {
            embed.addFields({ name: "🗺️ Missioni (Quests)", value: quests.map(q => `• ${q}`).join('\n') });
        }

        await targetChannel.send({ embeds: [embed] });
    }
    // ------------------------------------

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
                    await disconnect(guildId);
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
                    await disconnect(guildId);
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
