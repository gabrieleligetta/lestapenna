import { TextChannel, DMChannel, NewsChannel, ThreadChannel, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { Command, CommandContext } from '../types';
import { searchKnowledge } from '../../bard';

export const wikiCommand: Command = {
    name: 'wiki',
    aliases: ['lore'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args, activeCampaign } = ctx;
        const term = args.join(' ');
        if (!term) {
            await message.reply("Uso: `$wiki <Termine>`");
            return;
        }

        if ('sendTyping' in message.channel) {
            await (message.channel as TextChannel | DMChannel | NewsChannel | ThreadChannel).sendTyping();
        }

        try {
            const fragments = await searchKnowledge(activeCampaign!.id, term, 10);

            if (fragments.length === 0) {
                await message.reply("Non ho trovato nulla negli archivi su questo argomento.");
                return;
            }

            let index = 0;
            const total = fragments.length;

            const buildEmbed = (i: number) => {
                const MAX_LENGTH = 3800;
                const content = fragments[i].length > MAX_LENGTH
                    ? fragments[i].substring(0, MAX_LENGTH) + '... [troncato]'
                    : fragments[i];
                return new EmbedBuilder()
                    .setTitle(`📜 Archivio: "${term}"`)
                    .setDescription(content)
                    .setColor(0x8B4513)
                    .setFooter({ text: `Frammento ${i + 1} / ${total}` });
            };

            const buildRow = (i: number) => new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId('wiki_prev')
                    .setLabel('◀')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(i === 0),
                new ButtonBuilder()
                    .setCustomId('wiki_next')
                    .setLabel('▶')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(i === total - 1)
            );

            const reply = await message.reply({
                embeds: [buildEmbed(index)],
                components: total > 1 ? [buildRow(index)] : []
            });

            if (total <= 1) return;

            const collector = reply.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 5 * 60 * 1000,
                filter: (i) => i.user.id === message.author.id
            });

            collector.on('collect', async (interaction) => {
                if (interaction.customId === 'wiki_prev') index = Math.max(0, index - 1);
                else if (interaction.customId === 'wiki_next') index = Math.min(total - 1, index + 1);

                await interaction.update({
                    embeds: [buildEmbed(index)],
                    components: [buildRow(index)]
                });
            });

            collector.on('end', () => {
                if (reply.editable) reply.edit({ components: [] }).catch(() => {});
            });

        } catch (err) {
            console.error("Errore wiki:", err);
            await message.reply("Errore nella consultazione degli archivi.");
        }
    }
};
