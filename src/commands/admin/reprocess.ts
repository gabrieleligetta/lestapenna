import { TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { getSessionCampaignId, db } from '../../db';
import { monitor } from '../../monitor';
import { PipelineService } from '../../publisher/services/PipelineService';
import { IngestionService } from '../../publisher/services/IngestionService';
import { NotificationService } from '../../publisher/services/NotificationService';
import { purgeSessionData } from '../../services/janitor';
import { sessionPhaseManager } from '../../services/SessionPhaseManager';
import { t } from '../../i18n';
import { assertSessionInGuild } from '../utils/sessionScope';

export const reprocessCommand: Command = {
    name: 'reprocess',
    category: 'dev',
    descriptionKey: 'help.cmd.reprocess',
    aliases: ['riprocessa', 'regenerate'],
    requiresCampaign: false,
    operatorOnly: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args, client } = ctx;

        const targetSessionId = args[0];
        const isForce = args.some(arg => arg.toUpperCase() === 'FORCE');
        const isSilent = args.some(arg => arg.toUpperCase() === 'SILENT' || arg.toUpperCase() === 'SHHH');

        if (!targetSessionId) {
            await message.reply(t(ctx.locale, 'admin.reprocessUsage'));
            return;
        }

        if (!await assertSessionInGuild(ctx, targetSessionId)) return;

        const channel = message.channel as TextChannel;

        if (isForce) {
            await channel.send(t(ctx.locale, 'admin.forceMode'));
        } else {
            await channel.send(t(ctx.locale, 'admin.smartMode'));
        }

        if (isSilent) {
            await channel.send(t(ctx.locale, 'admin.silentMode'));
        }

        await channel.send(t(ctx.locale, 'admin.reprocessStarted', { id: targetSessionId }));

        // AVVIO MONITORAGGIO TEMPORANEO (se non attivo)
        let monitorStartedByUs = false;
        if (!monitor.isSessionActive()) {
            monitor.startSession(targetSessionId);
            monitorStartedByUs = true;
        }

        const pipelineService = new PipelineService();
        const ingestionService = new IngestionService();
        const notificationService = new NotificationService();

        try {
            // 0. CLEANUP (DB + RAG + Sync State)
            const campaignId = getSessionCampaignId(targetSessionId);
            if (!campaignId) throw new Error(t(ctx.locale, 'admin.campaignNotFoundSession'));

            purgeSessionData(targetSessionId);

            await channel.send(t(ctx.locale, 'admin.reprocessStep2'));

            // 2. Generate Summary (Pipeline)
            const result = await pipelineService.generateSessionSummary(targetSessionId, campaignId, 'DM', { forceRegeneration: isForce });

            // 3. Ingest to RAG & DB
            await ingestionService.ingestSummary(targetSessionId, result);
            ingestionService.updateSessionTitle(targetSessionId, result.title);

            // 4. Process Batch Events
            await ingestionService.processBatchEvents(campaignId, targetSessionId, result, channel, isSilent);

            // 📍 PHASE: DONE
            sessionPhaseManager.setPhase(targetSessionId, 'DONE');

            // 5. Publish (Skip if silent)
            if (!isSilent) {
                await notificationService.publishToDiscord(client, targetSessionId, result, channel);
                await notificationService.sendEmailRecap(targetSessionId, campaignId, result);
            }

            // 6. Metrics & Report (Skip report if silent)
            if (monitorStartedByUs) {
                if (!isSilent) {
                    await notificationService.reportMetrics();
                } else {
                    await monitor.endSession();
                }
            } else {
                console.log(`[Riprocessa] Costi confluiti nella sessione attiva monitorata.`);
            }

            await channel.send(t(ctx.locale, 'admin.reprocessComplete'));

        } catch (e: any) {
            console.error(`[Monitor] ❌ Errore riprocessamento:`, e);
            await channel.send(t(ctx.locale, 'admin.reprocessError', { message: e.message }));

            if (monitorStartedByUs) {
                await monitor.endSession();
            }
        }
    }
};
