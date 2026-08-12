import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction, StringSelectMenuBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import { getAvailableSessions, getSessionAIOutput } from '../../db';
import { parseSummaryData } from '../../bard/summaryData';
import { getPresignedUrl } from '../../services/backup';
import { t } from '../../i18n';

export const listCommand: Command = {
    name: 'list',
    category: 'sessione',
    descriptionKey: 'help.cmd.list',
    aliases: ['listasessioni', 'listsessions'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, activeCampaign } = ctx;

        // calling getAvailableSessions
        const sessions = getAvailableSessions(message.guild!.id, activeCampaign?.id, 0);

        if (sessions.length === 0) {
            await message.reply(t(ctx.locale, activeCampaign ? 'session.noneFoundCampaign' : 'session.noneFoundServer'));
            return;
        }

        const ITEMS_PER_PAGE = 5;
        const totalPages = Math.ceil(sessions.length / ITEMS_PER_PAGE);
        let currentPage = 0;

        const generateEmbed = (page: number) => {
            const start = page * ITEMS_PER_PAGE;
            const end = start + ITEMS_PER_PAGE;
            const currentSessions = sessions.slice(start, end);

            const list = currentSessions.map(s => {
                const title = s.title ? `📜 **${s.title}**` : "";
                const campaignInfo = !activeCampaign && s.campaign_name ? `\n🌍 **${s.campaign_name}**` : "";
                const fragments = t(ctx.locale, 'session.fragmentsCount', { n: s.fragments });
                return `🆔 \`${s.session_id}\`${campaignInfo}\n📅 ${new Date(s.start_time).toLocaleString()} (${fragments})\n${title}`;
            }).join('\n\n');

            return new EmbedBuilder()
                .setTitle(t(ctx.locale, 'session.chroniclesTitle', { name: activeCampaign?.name || t(ctx.locale, 'session.allCampaigns') }))
                .setColor("#7289DA")
                .setDescription(list)
                .setFooter({ text: t(ctx.locale, 'common.pageFooter', { page: page + 1, total: totalPages }) });
        };

        const generateButtons = (page: number) => {
            const row = new ActionRowBuilder<ButtonBuilder>();

            row.addComponents(
                new ButtonBuilder()
                    .setCustomId('prev_page')
                    .setLabel(t(ctx.locale, 'common.prevButton'))
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('next_page')
                    .setLabel(t(ctx.locale, 'common.nextButton'))
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages - 1)
            );

            return row;
        };

        const generateSelectMenu = (page: number) => {
            const start = page * ITEMS_PER_PAGE;
            const end = start + ITEMS_PER_PAGE;
            const currentSessions = sessions.slice(start, end);

            const select = new StringSelectMenuBuilder()
                .setCustomId('select_session')
                .setPlaceholder(t(ctx.locale, 'session.selectDetails'))
                .addOptions(
                    currentSessions.map(s => ({
                        label: s.title ? s.title.substring(0, 100) : t(ctx.locale, 'session.fallbackTitle', { date: new Date(s.start_time).toLocaleDateString() }),
                        description: `ID: ${s.session_id} | ${t(ctx.locale, 'session.fragmentsCount', { n: s.fragments })}`,
                        value: s.session_id,
                        emoji: '📜'
                    }))
                );
            return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
        };

        const generateComponents = (page: number) => {
            const comps: any[] = [];
            if (totalPages > 1) comps.push(generateButtons(page));
            comps.push(generateSelectMenu(page));
            return comps;
        };

        const options = {
            embeds: [generateEmbed(currentPage)],
            components: generateComponents(currentPage)
        };

        let reply: any;
        if (ctx.interaction) {
            reply = await ctx.interaction.update({ ...options, fetchReply: true });
        } else {
            reply = await message.reply(options);
        }

        const collector = reply.createMessageComponentCollector({
            time: 60000
        });

        collector.on('collect', async (interaction: MessageComponentInteraction) => {
            if (interaction.user.id !== message.author.id) {
                await interaction.reply({ content: t(ctx.locale, 'common.onlyInvoker'), ephemeral: true });
                return;
            }

            if (interaction.isButton()) {
                if (interaction.customId === 'prev_page') {
                    currentPage = Math.max(0, currentPage - 1);
                } else if (interaction.customId === 'next_page') {
                    currentPage = Math.min(totalPages - 1, currentPage + 1);
                }

                await interaction.update({
                    embeds: [generateEmbed(currentPage)],
                    components: generateComponents(currentPage)
                });
            } else if (interaction.isStringSelectMenu()) {
                if (interaction.customId === 'select_session') {
                    const selectedId = interaction.values[0];
                    const session = sessions.find(s => s.session_id === selectedId);

                    if (session) {
                        // Fetch detailed summary data
                        const aiData = getSessionAIOutput(session.session_id);
                        const summaryData = parseSummaryData(aiData?.summaryData);
                        const narrativeBrief = summaryData?.brief || '';

                        // Generate download links
                        const audioKey = `recordings/${session.session_id}/session_${session.session_id}_master.mp3`;
                        const transcriptKey = `transcripts/${session.session_id}/transcript_cleaned.txt`;

                        const audioUrl = await getPresignedUrl(audioKey, undefined, 3600 * 24);
                        const transcriptUrl = await getPresignedUrl(transcriptKey, undefined, 3600 * 24);

                        let downloadLinks = "";
                        if (audioUrl) downloadLinks += `[${t(ctx.locale, 'session.downloadAudio')}](${audioUrl}) `;
                        if (transcriptUrl) downloadLinks += `[${t(ctx.locale, 'session.downloadTranscript')}](${transcriptUrl})`;

                        const embed = new EmbedBuilder()
                            .setTitle(session.title ? `📜 ${session.title.substring(0, 250)}` : t(ctx.locale, 'session.detailsTitle'))
                            .setColor("#3498DB")
                            .setDescription(
                                (narrativeBrief ? t(ctx.locale, 'session.summarySection', { brief: narrativeBrief }) : `${t(ctx.locale, 'session.noSummary')}\n\n`) +
                                (downloadLinks ? `${t(ctx.locale, 'session.downloadHeading')}${downloadLinks}` : "")
                            )
                            .addFields(
                                { name: t(ctx.locale, 'session.fieldId'), value: `\`${session.session_id}\``, inline: true },
                                { name: t(ctx.locale, 'session.fieldDate'), value: new Date(session.start_time).toLocaleString(), inline: true },
                                { name: t(ctx.locale, 'session.fieldFragments'), value: session.fragments.toString(), inline: true },
                                { name: t(ctx.locale, 'session.fieldCampaign'), value: session.campaign_name || "N/A", inline: true }
                            );

                        await interaction.reply({ embeds: [embed], ephemeral: true });
                    } else {
                        await interaction.reply({ content: t(ctx.locale, 'session.notFound'), ephemeral: true });
                    }
                }
            }
        });

        collector.on('end', () => {
            reply.edit({ components: [] }).catch(() => { });
        });
    }
};
