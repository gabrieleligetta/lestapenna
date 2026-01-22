import { EmbedBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import { audioQueue, correctionQueue } from '../../queue';

export const statusCommand: Command = {
    name: 'status',
    aliases: ['stato'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message } = ctx;
        const audioCounts = await audioQueue.getJobCounts();
        const correctionCounts = await correctionQueue.getJobCounts();

        const embed = new EmbedBuilder()
            .setTitle("⚙️ Stato del Sistema")
            .setColor("#2ECC71")
            .addFields(
                { name: "🎙️ Coda Audio", value: `In attesa: ${audioCounts.waiting}\nAttivi: ${audioCounts.active}\nCompletati: ${audioCounts.completed}\nFalliti: ${audioCounts.failed}`, inline: true },
                { name: "🧠 Coda Correzione", value: `In attesa: ${correctionCounts.waiting}\nAttivi: ${correctionCounts.active}\nCompletati: ${correctionCounts.completed}\nFalliti: ${correctionCounts.failed}`, inline: true }
            )
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    }
};
