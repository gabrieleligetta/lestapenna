import {
    TextChannel,
    VoiceChannel,
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
    countAtlasEntries,
    getGuildConfig,
    tenantRepository
} from '../../db';
import { monitor } from '../../monitor';
import { connectToChannel } from '../../services/recorder';
import { randomUUID as uuidv4 } from 'crypto';
import { sessionPhaseManager } from '../../services/SessionPhaseManager';
import { checkAutoLeave } from '../../bootstrap/voiceState';
import { setActiveSession, incrementRecordingCount, getActiveSession } from '../../state/sessionState';
import { isRecordingPaused } from '../../services/recorder';
import { ensureTestEnvironment } from './testEnv';
import { startWorldConfigurationFlow } from '../utils/worldConfig';
import { startInteractiveLocationSelection } from './listenInteractive';
import { scheduleSessionHardCap } from '../../services/sessionHardCap';
import { t } from '../../i18n';
import { assertCampaignWrite } from '../utils/campaignWrite';
import { assertAiConfigured } from '../utils/aiConfigured';
import { sessionCostLine } from '../utils/sessionCostLine';
import { communityLine } from '../utils/communityLine';
import { announceRecording, markRecording } from '../../services/recordingNotice';

export const listenCommand: Command = {
    name: 'listen',
    category: 'sessione',
    descriptionKey: 'help.cmd.listen',
    aliases: ['ascolta', 'testascolta'],
    requiresCampaign: false, // Changed to false to allow test setup within the command
    // Recording is always allowed: the software is free and the table pays its own provider.

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args, activeCampaign, client } = ctx;
        const commandName = message.content.slice(1).split(' ')[0].toLowerCase();
        const isTestMode = commandName === 'testascolta';

        // Guard: block if a session is already active for this guild
        const existingSession = await getActiveSession(message.guild!.id);
        if (existingSession) {
            const isPaused = isRecordingPaused(message.guild!.id);
            const hint = t(ctx.locale, isPaused ? 'session.hintPaused' : 'session.hintStop');
            await message.reply(t(ctx.locale, 'session.alreadyActive', { id: `${existingSession.substring(0, 8)}...`, hint }));
            return;
        }

        if (isTestMode) {
            const setupCamp = await ensureTestEnvironment(message.guild!.id, message.author.id, message);
            if (setupCamp) ctx.activeCampaign = setupCamp;
            else return;
        }

        // Manual check for non-test mode since we disabled dispatcher check
            if (!ctx.activeCampaign) {
                await message.reply(t(ctx.locale, 'dispatcher.noCampaign'));
                return;
            }
            if (!await assertCampaignWrite(ctx)) return;

        // --- AI KEY CHECK ---
        // Before anything else: without keys the table would record hours of
        // audio nobody can transcribe or summarize. Better a refusal now, with
        // the link to fix it, than a lost session later.
        if (!await assertAiConfigured(ctx)) return;

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
                        .setLabel(t(ctx.locale, 'session.configureWorldButton'))
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('🌍')
                );

            const options = {
                content: t(ctx.locale, 'session.worldMissing'),
                components: [row]
            };

            const replyMsg = ctx.interaction
                ? await ctx.interaction.update({ ...options, fetchReply: true })
                : await message.reply(options);

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
            await message.reply(t(ctx.locale, 'session.needVoice'));
            return;
        }

        // --- LOCATION HANDLING ---
        const locationArg = args.join(' ');
        const sessionId = uuidv4();

        // Helper to proceed with session start after location is settled
        const proceedWithSessionStart = async () => {
            const voiceChannel = member!.voice.channel!; // We checked this earlier
            const humanMembers = voiceChannel.members.filter(m => !m.user.bot);
            const botMembers = voiceChannel.members.filter(m => m.user.bot);

            // 3. CHECK REQUIRED NAMES (normal mode only)
            if (!isTestMode) {
                const missingNames: string[] = [];
                humanMembers.forEach(m => {
                    const profile = getUserProfile(m.id, ctx.activeCampaign!.id);
                    if (!profile.character_name) {
                        missingNames.push(m.displayName);
                    }
                });

                if (missingNames.length > 0) {
                    await message.reply(t(ctx.locale, 'session.missingNames', {
                        campaign: ctx.activeCampaign!.name,
                        list: missingNames.map(n => t(ctx.locale, 'session.missingNameEntry', { name: n })).join('\n'),
                    }));
                    return;
                }
            }

            if (botMembers.size > 0) {
                const botNames = botMembers.map(b => b.displayName).join(', ');
                await (message.channel as TextChannel).send(t(ctx.locale, 'session.botsIgnored', { names: botNames }));
            }

            // --- CHECK EMAIL (Reminder) ---
            const guildEmail = getGuildConfig(message.guild!.id, 'report_recipients');
            const membersWithoutEmail: string[] = [];
            humanMembers.forEach(m => {
                const profile = getUserProfile(m.id, ctx.activeCampaign!.id);
                if (!profile.email) {
                    membersWithoutEmail.push(m.displayName);
                }
            });

            if (!guildEmail && membersWithoutEmail.length > 0) {
                await (message.channel as TextChannel).send(
                    t(ctx.locale, 'session.emailReminder', { names: membersWithoutEmail.join(', ') })
                );
            }

            // Before anything else: if the visible indicator cannot be shown, we do
            // not record. An indicator that can be switched off is not an
            // indicator.
            if (!await markRecording(message.guild!, voiceChannel as VoiceChannel)) {
                await message.reply(t(ctx.locale, 'recording.needNickname'));
                return;
            }
            await announceRecording(
                message.guild!,
                message.channel as TextChannel,
                voiceChannel as VoiceChannel,
                ctx.locale,
            );

            await setActiveSession(message.guild!.id, sessionId);
            createSession(sessionId, message.guild!.id, ctx.activeCampaign!.id);

            // 📊 Usage tracking: increment the sessions used
            tenantRepository.incrementSessions(message.guild!.id);

            // 📍 Set session phase to RECORDING
            sessionPhaseManager.setPhase(sessionId, 'RECORDING');

            monitor.startSession(sessionId);

            await incrementRecordingCount();
            console.log(`[Flow] Contatore recording incrementato per sessione ${sessionId}`);

            await connectToChannel(voiceChannel, sessionId);
            scheduleSessionHardCap(message.guild!.id, sessionId, client);
            const startedMsg = t(ctx.locale, 'session.started', {
                campaign: ctx.activeCampaign!.name,
                id: sessionId,
                count: humanMembers.size,
            }) + await sessionCostLine(ctx) + communityLine(ctx.guildId, ctx.locale);
            if (ctx.interaction && !ctx.interaction.replied && !ctx.interaction.deferred) {
                await ctx.interaction.update({ content: startedMsg, components: [], embeds: [] });
            } else {
                await message.reply(startedMsg);
            }

            if (checkAutoLeave) checkAutoLeave(voiceChannel, client);
        };

        if (locationArg) {
            // CASE 1: Explicit Argument (High Priority)
            let newMacro = null;
            let newMicro = null;

            if (locationArg.includes('|')) {
                const parts = locationArg.split('|').map(s => s.trim());
                newMacro = parts[0];
                newMicro = parts[1];
            } else {
                newMicro = locationArg.trim();
            }

            updateLocation(ctx.activeCampaign!.id, newMacro, newMicro, sessionId, undefined, undefined, false, true);
            const trackedMsg = t(ctx.locale, 'session.locationTracked', { macro: newMacro || '-', micro: newMicro || '-' });
            if (ctx.interaction && !ctx.interaction.replied && !ctx.interaction.deferred) {
                await ctx.interaction.update({ content: trackedMsg, components: [], embeds: [] });
            } else {
                await message.reply(trackedMsg);
            }
            await proceedWithSessionStart();

        } else {
            // CASE 2: No Argument -> Check Current or Interactive
            const currentLoc = getCampaignLocation(message.guild!.id);
            if (currentLoc && (currentLoc.macro || currentLoc.micro)) {
                // Location exists, use it
                const resumedMsg = t(ctx.locale, 'session.locationResumed', { macro: currentLoc.macro || '-', micro: currentLoc.micro || '-' });
                if (ctx.interaction && !ctx.interaction.replied && !ctx.interaction.deferred) {
                    await ctx.interaction.update({ content: resumedMsg, components: [], embeds: [] });
                } else {
                    await message.reply(resumedMsg);
                }
                await proceedWithSessionStart();
            } else {
                // Location missing, start interactive
                await startInteractiveLocationSelection(ctx, async (macro, micro) => {
                    updateLocation(ctx.activeCampaign!.id, macro, micro, sessionId, undefined, undefined, false, true);
                    await proceedWithSessionStart();
                });
            }
        }
    }
};
