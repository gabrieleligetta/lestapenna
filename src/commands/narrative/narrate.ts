import { EmbedBuilder, TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import {
    getAvailableSessions,
    getSessionCampaignId as getSessionCampaignIdFromDb,
    db
} from '../../db';
import {
    TONES,
    ToneKey,
    invalidateManifesto
} from '../../bard';
import { monitor } from '../../monitor';
import { PipelineService } from '../../publisher/services/PipelineService';
import { IngestionService } from '../../publisher/services/IngestionService';
import { NotificationService } from '../../publisher/services/NotificationService';
import { sessionPhaseManager } from '../../services/SessionPhaseManager';
import { purgeSessionData } from '../../services/janitor';
import { t, dateLocale } from '../../i18n';
import { assertSessionInActiveCampaign } from '../utils/sessionScope';
import { assertCampaignWrite } from '../utils/campaignWrite';
import { isGuildOperator } from '../../utils/permissions';

export const narrateCommand: Command = {
    name: 'narrate',
    category: 'narrativa',
    descriptionKey: 'help.cmd.narrate',
    aliases: ['racconta', 'summarize'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args, activeCampaign, client } = ctx;

        if (!await assertCampaignWrite(ctx)) return;

        // Parse arguments: $racconta <ID> [tono] [--reindex]
        let targetSessionId = args[0];
        let requestedTone: ToneKey | undefined;
        let forceReindex = false;

        // Parse remaining args
        for (let i = 1; i < args.length; i++) {
            const arg = args[i].toLowerCase();
            if (arg === '--reindex' || arg === 'reindex' || arg === 'force') {
                forceReindex = true;
            } else if (!requestedTone && TONES[arg.toUpperCase() as ToneKey]) {
                requestedTone = arg.toUpperCase() as ToneKey;
            }
        }

        // ... existing validation checks ...

        if (!targetSessionId) {
            // Show the active campaign's sessions
            const sessions = getAvailableSessions(message.guild!.id, activeCampaign?.id);
            if (sessions.length === 0) {
                await message.reply(t(ctx.locale, 'narrative.noSessions'));
                return;
            }
            const list = sessions.map(s => t(ctx.locale, 'narrative.sessionListItem', {
                id: s.session_id,
                date: new Date(s.start_time).toLocaleString(dateLocale(ctx.locale)),
                fragments: s.fragments
            })).join('\n\n');
            const embed = new EmbedBuilder().setTitle(t(ctx.locale, 'narrative.sessionsTitle', { name: activeCampaign?.name ?? '' })).setDescription(list);
            await message.reply({ embeds: [embed] });
            return;
        }

        if (requestedTone && !TONES[requestedTone]) {
            await message.reply(t(ctx.locale, 'narrative.invalidTone', { tones: Object.keys(TONES).join(', ') }));
            return;
        }

        // The id came from the arguments (the no-id branch already returned
        // above, listing this guild's sessions).
        if (!await assertSessionInActiveCampaign(ctx, targetSessionId)) return;

        if (forceReindex && !isGuildOperator(message.author.id, ctx.guildId, message.member)) {
            await message.reply(t(ctx.locale, 'dispatcher.operatorOnly', { cmd: '$narrate --reindex' }));
            return;
        }

        const channel = message.channel as TextChannel;
        await channel.send(t(ctx.locale, 'narrative.consultingArchives', { id: targetSessionId }));

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
            // Check session status
            const phaseInfo = sessionPhaseManager.getPhase(targetSessionId);
            const isAlreadyProcessed = phaseInfo?.phase === 'DONE';

            // If it is already processed and no reindex was requested, skip the ingestion part
            const shouldIngest = forceReindex || !isAlreadyProcessed;

            if (isAlreadyProcessed && !forceReindex) {
                await channel.send(t(ctx.locale, 'narrative.alreadyIndexed'));
            } else if (forceReindex) {
                await channel.send(t(ctx.locale, 'narrative.forceReindex'));
            }

            await channel.send(t(ctx.locale, 'narrative.preparingText'));
            await channel.send(t(ctx.locale, 'narrative.startWriting'));

            // 1. Prepare Flags
            // Logic:
            // - If forceReindex: Clean everything first, then run Full Analysis
            // - If NOT forceReindex (and already processed): Skip Analysis, Hydrate from DB
            // - If new session: Full Analysis (default)

            const skipAnalysis = !shouldIngest;

            if (forceReindex) {
                await channel.send(t(ctx.locale, 'narrative.cleaningData'));
                purgeSessionData(targetSessionId);
            }

            // 2. Generate Summary (Pipeline)
            const result = await pipelineService.generateSessionSummary(
                targetSessionId,
                activeCampaign!.id,
                requestedTone || 'DM',
                {
                    skipAnalysis,
                    forceRegeneration: forceReindex // 🆕 Link force behavior
                }
            );

            if (shouldIngest) {
                // 3. Ingest to RAG & DB
                await ingestionService.ingestSummary(targetSessionId, result);
                ingestionService.updateSessionTitle(targetSessionId, result.title);

                // 4. Process Batch Events
                if (activeCampaign) {
                    await ingestionService.processBatchEvents(activeCampaign.id, targetSessionId, result, channel);
                    // 🆕 Invalidate Manifesto for next run
                    invalidateManifesto(activeCampaign.id);
                }

                // Update phase to DONE if we ingested
                sessionPhaseManager.setPhase(targetSessionId, 'DONE');
            } else {
                console.log(`[Racconta] Saltata indicizzazione per ${targetSessionId}.`);
            }

            // 4. Publish to Discord (always, it is the point of the command)
            await notificationService.publishToDiscord(client, targetSessionId, result, channel);

            // 5. Email Recap (always)
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
            await channel.send(t(ctx.locale, 'narrative.summaryGenError', { error: err.message }));

            // On error, if we had opened the monitor, close it anyway for cleanliness
            if (monitorStartedByUs) {
                await monitor.endSession();
            }
        }
    }
};
