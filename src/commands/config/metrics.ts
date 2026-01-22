import { EmbedBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import { monitor } from '../../monitor';

export const metricsCommand: Command = {
    name: 'metrics',
    aliases: ['metriche'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message } = ctx;
        // Accesso a proprietà privata monitor.currentSession via cast (come in index.ts)
        const m = (monitor as any).currentSession as any; // Using any to avoid importing SessionMetrics type if difficult, or import from monitor?
        // SessionMetrics is exported from monitor? Let's check imports.
        // It was used in index.ts: import { SessionMetrics } from './monitor';

        if (!m) {
            await message.reply("⚠️ Nessuna sessione attiva monitorata al momento.");
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle(`📊 Metriche Live: Sessione ${m.sessionId.substring(0, 8)}...`)
            .setColor("#3498DB")
            .addFields(
                { name: "🎙️ File Processati", value: `${m.totalFiles}`, inline: true },
                { name: "⚡ Whisper Speed", value: `${(m.whisperMetrics?.avgProcessingRatio || 0).toFixed(2)}x`, inline: true },
                { name: "⏳ Coda (Avg Wait)", value: `${((m.queueMetrics?.avgWaitTimeMs || 0) / 1000).toFixed(1)}s`, inline: true },
                { name: "💻 CPU (Last)", value: `${m.resourceUsage.cpuSamples.slice(-1)[0] || 0}%`, inline: true },
                { name: "🧠 RAM (Last)", value: `${m.resourceUsage.ramSamplesMB.slice(-1)[0] || 0} MB`, inline: true },
                { name: "💾 DB Growth", value: `${((m.dbEndSizeBytes || 0) - (m.dbStartSizeBytes || 0) / (1024 * 1024)).toFixed(2)} MB`, inline: true }
            )
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    }
};
