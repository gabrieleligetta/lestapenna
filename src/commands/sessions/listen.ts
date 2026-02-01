import {
    TextChannel,
    DMChannel,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType
} from 'discord.js';
import { Command, CommandContext } from '../types';
import {

    getActiveCampaign,
    getUserProfile,
    updateUserCharacter,
    updateLocation,
    getCampaignLocation,
    createSession,
    setCampaignYear,
    addWorldEvent,
    factionRepository,
    getAtlasEntryFull,

    updateAtlasEntry,
    listAtlasEntries,
    countAtlasEntries
} from '../../db';
import { monitor } from '../../monitor';
import { audioQueue } from '../../services/queue';
import { connectToChannel } from '../../services/recorder';
import { v4 as uuidv4 } from 'uuid';
import { sessionPhaseManager } from '../../services/SessionPhaseManager';
import { checkAutoLeave } from '../../bootstrap/voiceState';
import { guildSessions } from '../../state/sessionState';
import { ensureTestEnvironment } from './testEnv';
import { startWorldConfigurationFlow } from '../utils/worldConfig';

export const listenCommand: Command = {
    name: 'listen',
    aliases: ['ascolta', 'testascolta'],
    requiresCampaign: false, // Changed to false to allow test setup within the command

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args, activeCampaign, client } = ctx;
        const commandName = message.content.slice(1).split(' ')[0].toLowerCase();
        const isTestMode = commandName === 'testascolta';

        if (isTestMode) {
            const setupCamp = await ensureTestEnvironment(message.guild!.id, message.author.id, message);
            if (setupCamp) ctx.activeCampaign = setupCamp;
            else return;
        }

        // Manual check for non-test mode since we disabled dispatcher check
        if (!ctx.activeCampaign) {
            await message.reply("⚠️ **Nessuna campagna attiva!**\nUsa `$creacampagna <Nome>` o `$selezionacampagna <Nome>` prima di iniziare.");
            return;
        }

        // --- CHECK CONFIGURAZIONE MONDO (Interattivo) ---
        const camp = ctx.activeCampaign!;
        const currentLoc = getCampaignLocation(message.guild!.id);
        const partyFaction = factionRepository.getPartyFaction(camp.id);
        const isWorldConfigured =
            (camp.current_year !== undefined && camp.current_year !== null) &&
            (currentLoc && (currentLoc.macro || currentLoc.micro)) &&
            (partyFaction && partyFaction.name !== 'Heros Party');

        if (!isWorldConfigured) {
            const row = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('btn_config_world')
                        .setLabel('Configura Mondo')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('🌍')
                );

            const replyMsg = await message.reply({
                content: `🛑 **Configurazione Mancante!**\nPer iniziare la cronaca, dobbiamo definire alcuni dettagli del mondo.\nClicca qui sotto per impostarli rapidamente:`,
                components: [row]
            });

            const collector = replyMsg.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 60000,
                filter: (i) => i.customId === 'btn_config_world' && i.user.id === message.author.id
            });

            collector.on('collect', async (interaction) => {
                await startWorldConfigurationFlow(interaction, camp.id, partyFaction);
            });
            return;
        }

        const member = message.member;
        if (!member?.voice.channel) {
            await message.reply("Devi essere in un canale vocale per evocare il Bardo!");
            return;
        }

        // --- GESTIONE LUOGO ---
        const locationArg = args.join(' ');
        const sessionId = uuidv4();

        if (locationArg) {
            let newMacro = null;
            let newMicro = null;

            if (locationArg.includes('|')) {
                const parts = locationArg.split('|').map(s => s.trim());
                newMacro = parts[0];
                newMicro = parts[1];
            } else {
                newMicro = locationArg.trim();
            }

            updateLocation(ctx.activeCampaign!.id, newMacro, newMicro, sessionId);
            await message.reply(`📍 Posizione tracciata: **${newMacro || '-'}** | **${newMicro || '-'}**.\nIl Bardo userà questo contesto per le trascrizioni.`);
        } else {
            const currentLoc = getCampaignLocation(message.guild!.id);
            if (currentLoc && (currentLoc.macro || currentLoc.micro)) {
                await message.reply(`📍 Luogo attuale: **${currentLoc.macro || '-'}** | **${currentLoc.micro || '-'}** (Se è cambiato, usa \`$ascolta Macro | Micro\`)`);
            } else {
                await message.reply(`⚠️ **Luogo Sconosciuto.**\nConsiglio: scrivi \`$ascolta <Città> | <Luogo>\` per aiutare il Bardo a capire meglio i nomi e l'atmosfera.`);
            }
        }

        const voiceChannel = member.voice.channel;
        const humanMembers = voiceChannel.members.filter(m => !m.user.bot);
        const botMembers = voiceChannel.members.filter(m => m.user.bot);

        // 2. AUTO-ASSEGNAZIONE NOMI IN TEST MODE (Simplified or skipped if test logic missing)
        // ...

        // 3. CHECK NOMI OBBLIGATORI (Solo in modalità normale)
        if (!isTestMode) {
            const missingNames: string[] = [];
            humanMembers.forEach(m => {
                const profile = getUserProfile(m.id, ctx.activeCampaign!.id);
                if (!profile.character_name) {
                    missingNames.push(m.displayName);
                }
            });

            if (missingNames.length > 0) {
                await message.reply(
                    `🛑 **ALT!** Non posso iniziare la cronaca per **${ctx.activeCampaign!.name}**.\n` +
                    `I seguenti avventurieri non hanno dichiarato il loro nome in questa campagna:\n` +
                    missingNames.map(n => `- **${n}** (Usa: \`$sono NomePersonaggio\`)`).join('\n')
                );
                return;
            }
        }

        if (botMembers.size > 0) {
            const botNames = botMembers.map(b => b.displayName).join(', ');
            await (message.channel as TextChannel).send(`🤖 Noto la presenza di costrutti magici (${botNames}). Le loro voci saranno ignorate.`);
        }

        guildSessions.set(message.guild!.id, sessionId);
        createSession(sessionId, message.guild!.id, ctx.activeCampaign!.id);

        // 📍 Set session phase to RECORDING
        sessionPhaseManager.setPhase(sessionId, 'RECORDING');

        monitor.startSession(sessionId);

        await audioQueue.pause();
        console.log(`[Flow] Coda in PAUSA. Inizio accumulo file per sessione ${sessionId}`);

        await connectToChannel(voiceChannel, sessionId);
        await message.reply(`🔊 **Cronaca Iniziata** per la campagna **${ctx.activeCampaign!.name}**.\nID Sessione: \`${sessionId}\`.\nI bardi stanno ascoltando ${humanMembers.size} eroi.`);

        if (checkAutoLeave) checkAutoLeave(voiceChannel, client);
    }
};
