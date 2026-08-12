import { EmbedBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import { monitor } from '../../monitor';
import { t } from '../../i18n';

export const metricsCommand: Command = {
    name: 'metrics',
    category: 'admin',
    descriptionKey: 'help.cmd.metrics',
    aliases: ['metriche'],
    requiresCampaign: false,
    // Reports the host's CPU and RAM: on a shared instance that is somebody
    // else's infrastructure being fingerprinted, not this table's business.
    adminOnly: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message } = ctx;
        // Reaches monitor.currentSession through a cast: the field is private and
        // this command only reads it to render a snapshot.
        const m = (monitor as any).currentSession as any;

        if (!m) {
            await message.reply(t(ctx.locale, 'config.metricsNone'));
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle(t(ctx.locale, 'config.metricsTitle', { id: m.sessionId.substring(0, 8) }))
            .setColor("#3498DB")
            .addFields(
                { name: t(ctx.locale, 'config.metricsFiles'), value: `${m.totalFiles}`, inline: true },
                { name: t(ctx.locale, 'config.metricsWhisper'), value: `${(m.whisperMetrics?.avgProcessingRatio || 0).toFixed(2)}x`, inline: true },
                { name: t(ctx.locale, 'config.metricsQueue'), value: `${((m.queueMetrics?.avgWaitTimeMs || 0) / 1000).toFixed(1)}s`, inline: true },
                { name: t(ctx.locale, 'config.metricsCpu'), value: `${m.resourceUsage.cpuSamples.slice(-1)[0] || 0}%`, inline: true },
                { name: t(ctx.locale, 'config.metricsRam'), value: `${m.resourceUsage.ramSamplesMB.slice(-1)[0] || 0} MB`, inline: true },
                { name: t(ctx.locale, 'config.metricsDb'), value: `${((m.dbEndSizeBytes || 0) - (m.dbStartSizeBytes || 0) / (1024 * 1024)).toFixed(2)} MB`, inline: true }
            )
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    }
};
