/**
 * $listacampagne / $listcampaigns command - List campaigns
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction } from 'discord.js';
import { Command, CommandContext } from '../types';
import { getCampaigns, getActiveCampaign } from '../../db';

export const listCampaignsCommand: Command = {
    name: 'listcampaigns',
    aliases: ['listacampagne'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const campaigns = getCampaigns(ctx.guildId);
        const active = getActiveCampaign(ctx.guildId);

        if (campaigns.length === 0) {
            await ctx.message.reply("Nessuna campagna trovata. Creane una con `$creacampagna`.");
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

        const reply = await ctx.message.reply({
            embeds: [generateEmbed(currentPage)],
            components: totalPages > 1 ? [generateButtons(currentPage)] : []
        });

        if (totalPages > 1) {
            const collector = reply.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 60000
            });

            collector.on('collect', async (interaction: MessageComponentInteraction) => {
                if (interaction.user.id !== ctx.message.author.id) {
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
};
