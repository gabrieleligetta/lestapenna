/**
 * $listacampagne / $listcampaigns command - List campaigns
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction, StringSelectMenuBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import { getCampaigns, getActiveCampaign } from '../../db';
import { t } from '../../i18n';

export const listCampaignsCommand: Command = {
    name: 'listcampaigns',
    category: 'campagna',
    descriptionKey: 'help.cmd.listcampaigns',
    aliases: ['listacampagne'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const campaigns = getCampaigns(ctx.guildId);
        const active = getActiveCampaign(ctx.guildId);

        if (campaigns.length === 0) {
            await ctx.message.reply(t(ctx.locale, 'campaign.none'));
            return;
        }

        const ITEMS_PER_PAGE = 5;
        const totalPages = Math.ceil(campaigns.length / ITEMS_PER_PAGE);
        let currentPage = 0;

        const generateEmbed = (page: number) => {
            const start = page * ITEMS_PER_PAGE;
            const end = start + ITEMS_PER_PAGE;
            const currentCampaigns = campaigns.slice(start, end);

            const list = currentCampaigns.map(c =>
                `${c.id === active?.id ? '👉 ' : ''}**${c.name}**`
            ).join('\n');

            return new EmbedBuilder()
                .setTitle(t(ctx.locale, 'campaign.listTitle'))
                .setDescription(list)
                .setColor("#E67E22")
                .setFooter({ text: t(ctx.locale, 'common.pageFooter', { page: page + 1, total: totalPages }) });
        };

        const generateButtons = (page: number) => {
            const row = new ActionRowBuilder<ButtonBuilder>();

            row.addComponents(
                new ButtonBuilder()
                    .setCustomId('prev_page_camp')
                    .setLabel(t(ctx.locale, 'common.prevButton'))
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('next_page_camp')
                    .setLabel(t(ctx.locale, 'common.nextButton'))
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages - 1)
            );

            return row;
        };

        const generateSelectMenu = (page: number) => {
            const start = page * ITEMS_PER_PAGE;
            const end = start + ITEMS_PER_PAGE;
            const currentCampaigns = campaigns.slice(start, end);

            const select = new StringSelectMenuBuilder()
                .setCustomId('select_campaign')
                .setPlaceholder(t(ctx.locale, 'campaign.selectDetails'))
                .addOptions(
                    currentCampaigns.map(c => ({
                        label: c.name.substring(0, 100),
                        description: c.id === active?.id ? t(ctx.locale, 'campaign.active') : `ID: ${c.id}`,
                        value: c.id.toString(),
                        emoji: c.id === active?.id ? '👉' : '🗺️'
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

        const reply = await ctx.message.reply({
            embeds: [generateEmbed(currentPage)],
            components: generateComponents(currentPage)
        });

        const collector = reply.createMessageComponentCollector({
            time: 60000
        });

        collector.on('collect', async (interaction: MessageComponentInteraction) => {
            if (interaction.user.id !== ctx.message.author.id) {
                await interaction.reply({ content: t(ctx.locale, 'common.onlyInvoker'), ephemeral: true });
                return;
            }

            if (interaction.isButton()) {
                if (interaction.customId === 'prev_page_camp') {
                    currentPage = Math.max(0, currentPage - 1);
                } else if (interaction.customId === 'next_page_camp') {
                    currentPage = Math.min(totalPages - 1, currentPage + 1);
                }

                await interaction.update({
                    embeds: [generateEmbed(currentPage)],
                    components: generateComponents(currentPage)
                });
            } else if (interaction.isStringSelectMenu()) {
                if (interaction.customId === 'select_campaign') {
                    const selectedId = parseInt(interaction.values[0]);
                    const selectedCampaign = campaigns.find(c => c.id === selectedId);

                    if (selectedCampaign) {
                        const embed = new EmbedBuilder()
                            .setTitle(t(ctx.locale, 'campaign.detailTitle', { name: selectedCampaign.name }))
                            .setColor(selectedCampaign.id === active?.id ? "#2ECC71" : "#E67E22")
                            .setDescription(selectedCampaign.current_location
                                ? t(ctx.locale, 'campaign.location', { location: selectedCampaign.current_location })
                                : t(ctx.locale, 'campaign.noLocation'))
                            .addFields(
                                { name: t(ctx.locale, 'campaign.status'), value: selectedCampaign.id === active?.id ? t(ctx.locale, 'campaign.activeStatus') : t(ctx.locale, 'campaign.inactiveStatus'), inline: true },
                                { name: t(ctx.locale, 'campaign.databaseId'), value: selectedCampaign.id.toString(), inline: true },
                                { name: t(ctx.locale, 'campaign.guildServer'), value: selectedCampaign.guild_id || 'N/A', inline: true }
                            )
                            .setFooter({ text: t(ctx.locale, 'campaign.activateFooter') });

                        await interaction.reply({ embeds: [embed], ephemeral: true });
                    } else {
                        await interaction.reply({ content: t(ctx.locale, 'campaign.notFound'), ephemeral: true });
                    }
                }
            }
        });

        collector.on('end', () => {
            reply.edit({ components: [] }).catch(() => { });
        });
    }
};
