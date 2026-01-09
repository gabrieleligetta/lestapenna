import { Message, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction, TextChannel } from 'discord.js';
import { createCampaign, getCampaigns, getActiveCampaign, setActiveCampaign, deleteCampaign } from '../../db';

export async function handleCampaignCommands(message: Message, command: string, args: string[]) {
    if (command === 'creacampagna' || command === 'createcampaign') {
        const name = args.join(' ');
        if (!name) return await message.reply("Uso: `$creacampagna <Nome Campagna>`");

        createCampaign(message.guild!.id, name);
        return await message.reply(`✅ Campagna **${name}** creata! Usa \`$selezionacampagna ${name}\` per attivarla.`);
    }

    if (command === 'listacampagne' || command === 'listcampaigns') {
        const campaigns = getCampaigns(message.guild!.id);
        const active = getActiveCampaign(message.guild!.id);

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
        return;
    }

    if (command === 'selezionacampagna' || command === 'setcampagna' || command === 'selectcampaign' || command === 'setcampaign') {
        const nameOrId = args.join(' ');
        if (!nameOrId) return await message.reply("Uso: `$selezionacampagna <Nome o ID>`");

        const campaigns = getCampaigns(message.guild!.id);
        const target = campaigns.find(c => c.name.toLowerCase() === nameOrId.toLowerCase() || c.id.toString() === nameOrId);

        if (!target) return await message.reply("⚠️ Campagna non trovata.");

        setActiveCampaign(message.guild!.id, target.id);
        return await message.reply(`✅ Campagna attiva impostata su: **${target.name}**.`);
    }

    if (command === 'eliminacampagna' || command === 'deletecampaign') {
        const nameOrId = args.join(' ');
        if (!nameOrId) return await message.reply("Uso: `$eliminacampagna <Nome o ID>`");

        const campaigns = getCampaigns(message.guild!.id);
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
        return;
    }
}
