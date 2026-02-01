/**
 * $listacampagne / $listcampaigns command - List campaigns
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction, StringSelectMenuBuilder } from 'discord.js';
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
                `${c.id === active?.id ? '👉 ' : ''}**${c.name}**`
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

        const generateSelectMenu = (page: number) => {
            const start = page * ITEMS_PER_PAGE;
            const end = start + ITEMS_PER_PAGE;
            const currentCampaigns = campaigns.slice(start, end);

            const select = new StringSelectMenuBuilder()
                .setCustomId('select_campaign')
                .setPlaceholder('🔍 Seleziona una campagna per dettagli...')
                .addOptions(
                    currentCampaigns.map(c => ({
                        label: c.name.substring(0, 100),
                        description: c.id === active?.id ? 'Attiva' : `ID: ${c.id}`,
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
                await interaction.reply({ content: "Solo chi ha invocato il comando può interagire.", ephemeral: true });
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
                            .setTitle(`📜 Campagna: ${selectedCampaign.name}`)
                            .setColor(selectedCampaign.id === active?.id ? "#2ECC71" : "#E67E22")
                            .setDescription(selectedCampaign.current_location ? `📍 Posizione: ${selectedCampaign.current_location}` : "*Nessuna posizione attuale.*")
                            .addFields(
                                { name: "Stato", value: selectedCampaign.id === active?.id ? "✅ ATTIVA" : "💤 Inattiva", inline: true },
                                { name: "ID Database", value: selectedCampaign.id.toString(), inline: true },
                                { name: "Guild Server", value: selectedCampaign.guild_id || "N/A", inline: true }
                            )
                            .setFooter({ text: "Usa $activate per rendere attiva questa campagna." });

                        await interaction.reply({ embeds: [embed], ephemeral: true });
                    } else {
                        await interaction.reply({ content: "Campagna non trovata.", ephemeral: true });
                    }
                }
            }
        });

        collector.on('end', () => {
            reply.edit({ components: [] }).catch(() => { });
        });
    }
};
