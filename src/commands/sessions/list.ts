import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction } from 'discord.js';
import { Command, CommandContext } from '../types';
import { getAvailableSessions } from '../../db';

export const listCommand: Command = {
    name: 'list',
    aliases: ['listasessioni', 'listsessions'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, activeCampaign } = ctx;

        // calling getAvailableSessions
        const sessions = getAvailableSessions(message.guild!.id, activeCampaign?.id, 0);

        if (sessions.length === 0) {
            if (activeCampaign) {
                await message.reply("Nessuna sessione trovata negli archivi per questa campagna.");
            } else {
                await message.reply("Nessuna sessione trovata negli archivi del server. Usa `$creacampagna` per iniziare!");
            }
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
                return `🆔 \`${s.session_id}\`${campaignInfo}\n📅 ${new Date(s.start_time).toLocaleString()} (${s.fragments} frammenti)\n${title}`;
            }).join('\n\n');

            return new EmbedBuilder()
                .setTitle(`📜 Cronache: ${activeCampaign?.name || 'Tutte le Campagne'}`)
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
                reply.edit({ components: [] }).catch(() => { });
            });
        }
    }
};
