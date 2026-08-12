import { EmbedBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import { audioQueue, correctionQueue } from '../../services/queue';
import { t } from '../../i18n';

export const statusCommand: Command = {
    name: 'status',
    category: 'admin',
    descriptionKey: 'help.cmd.status',
    aliases: ['stato'],
    requiresCampaign: false,
    // Queue depth is infrastructure state of the host, not campaign content.
    adminOnly: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message } = ctx;
        const audioCounts = await audioQueue.getJobCounts();
        const correctionCounts = await correctionQueue.getJobCounts();

        const embed = new EmbedBuilder()
            .setTitle(t(ctx.locale, 'config.statusTitle'))
            .setColor("#2ECC71")
            .addFields(
                { name: t(ctx.locale, 'config.audioQueue'), value: t(ctx.locale, 'config.queueCounts', audioCounts), inline: true },
                { name: t(ctx.locale, 'config.correctionQueue'), value: t(ctx.locale, 'config.queueCounts', correctionCounts), inline: true }
            )
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    }
};
