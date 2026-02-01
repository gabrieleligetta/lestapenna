import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction, StringSelectMenuBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import { getAvailableSessions, getSessionAIOutput } from '../../db';

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

        const generateSelectMenu = (page: number) => {
            const start = page * ITEMS_PER_PAGE;
            const end = start + ITEMS_PER_PAGE;
            const currentSessions = sessions.slice(start, end);

            const select = new StringSelectMenuBuilder()
                .setCustomId('select_session')
                .setPlaceholder('🔍 Seleziona sessione per dettagli...')
                .addOptions(
                    currentSessions.map(s => ({
                        label: s.title ? s.title.substring(0, 100) : `Sessione ${new Date(s.start_time).toLocaleDateString()}`,
                        description: `ID: ${s.session_id} | Frammenti: ${s.fragments}`,
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
                await interaction.reply({ content: "Solo chi ha invocato il comando può interagire.", ephemeral: true });
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
                        const narrativeBrief = aiData?.summaryData?.narrativeBrief;

                        const embed = new EmbedBuilder()
                            .setTitle(session.title ? `📜 ${session.title.substring(0, 250)}` : "📜 Dettagli Sessione")
                            .setColor("#3498DB")
                            .setDescription(narrativeBrief ? `### 📝 Riassunto\n${narrativeBrief}` : "*Nessun riassunto disponibile.*")
                            .addFields(
                                { name: "🆔 ID", value: `\`${session.session_id}\``, inline: true },
                                { name: "📅 Data", value: new Date(session.start_time).toLocaleString(), inline: true },
                                { name: "🧩 Frammenti", value: session.fragments.toString(), inline: true },
                                { name: "🌍 Campagna", value: session.campaign_name || "N/A", inline: true }
                            )
                            .setFooter({ text: "Usa $transcript per il verbale completo." });

                        await interaction.reply({ embeds: [embed], ephemeral: true });
                    } else {
                        await interaction.reply({ content: "Sessione non trovata.", ephemeral: true });
                    }
                }
            }
        });

        collector.on('end', () => {
            reply.edit({ components: [] }).catch(() => { });
        });
    }
};
