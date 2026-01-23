import { EmbedBuilder, TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import {
    getAvailableSessions,
    getSessionCampaignId as getSessionCampaignIdFromDb
} from '../../db';
import {
    TONES,
    ToneKey
} from '../../bard';
import { monitor } from '../../monitor';
import { PipelineService } from '../../publisher/services/PipelineService';
import { IngestionService } from '../../publisher/services/IngestionService';
import { NotificationService } from '../../publisher/services/NotificationService';

export const narrateCommand: Command = {
    name: 'narrate',
    aliases: ['racconta', 'summarize'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args, activeCampaign, client } = ctx;
        const targetSessionId = args[0];
        const requestedTone = args[1]?.toUpperCase() as ToneKey;

        if (!targetSessionId) {
            // Mostra sessioni della campagna attiva
            const sessions = getAvailableSessions(message.guild!.id, activeCampaign?.id);
            if (sessions.length === 0) {
                await message.reply("Nessuna sessione trovata per questa campagna.");
                return;
            }
            const list = sessions.map(s => `🆔 \`${s.session_id}\`\n📅 ${new Date(s.start_time).toLocaleString()} (${s.fragments} frammenti)`).join('\n\n');
            const embed = new EmbedBuilder().setTitle(`📜 Sessioni: ${activeCampaign?.name}`).setDescription(list);
            await message.reply({ embeds: [embed] });
            return;
        }

        if (requestedTone && !TONES[requestedTone]) {
            await message.reply(`Tono non valido. Toni: ${Object.keys(TONES).join(', ')}`);
            return;
        }

        const channel = message.channel as TextChannel;
        await channel.send(`📜 Il Bardo sta consultando gli archivi per la sessione \`${targetSessionId}\`...`);

        // AVVIO MONITORAGGIO TEMPORANEO (se non attivo)
        let monitorStartedByUs = false;
        if (!monitor.isSessionActive()) {
            monitor.startSession(targetSessionId);
            monitorStartedByUs = true;
        }

        // Initialize Services
        const pipelineService = new PipelineService();
        const ingestionService = new IngestionService();
        const notificationService = new NotificationService();

        try {
            await channel.send("📚 Il Bardo sta preparando il testo...");
            await channel.send("✍️ Inizio stesura del racconto...");

            // 1. Generate Summary (Pipeline)
            const result = await pipelineService.generateSessionSummary(targetSessionId, activeCampaign!.id, requestedTone || 'DM');

            // 2. Ingest to RAG & DB
            await ingestionService.ingestSummary(targetSessionId, result);
            ingestionService.updateSessionTitle(targetSessionId, result.title);

            // 3. Process Batch Events
            if (activeCampaign) {
                await ingestionService.processBatchEvents(activeCampaign.id, targetSessionId, result, channel);
            }

            // 4. Publish to Discord
            await notificationService.publishToDiscord(client, targetSessionId, result, channel);

            // 5. Email Recap
            const currentCampaignId = getSessionCampaignIdFromDb(targetSessionId) || activeCampaign?.id;
            if (currentCampaignId) {
                await notificationService.sendEmailRecap(targetSessionId, currentCampaignId, result);
            }

            // 6. Metrics & Report
            if (monitorStartedByUs) {
                await notificationService.reportMetrics();
            } else {
                console.log(`[Racconta] Costi confluiti nella sessione attiva monitorata.`);
            }

        } catch (err: any) {
            console.error(`❌ Errore racconta ${targetSessionId}:`, err);
            await channel.send(`⚠️ Errore durante la generazione del riassunto: ${err.message}`);

            // Se errore, e avevamo aperto il monitor, chiudiamolo comunque per pulizia
            if (monitorStartedByUs) {
                await monitor.endSession();
            }
        }
    }
};
