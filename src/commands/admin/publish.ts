/**
 * $pubblica_tutto - Publishes the summaries of every session to the channel
 * using the data already in the DB (no AI calls).
 * Also mails the technical recap for each session.
 */

import { TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { db } from '../../db';
import { PipelineService } from '../../publisher/services/PipelineService';
import { NotificationService } from '../../publisher/services/NotificationService';
import { monitor } from '../../monitor';
import { t } from '../../i18n';

interface SessionInfo {
    session_id: string;
    campaign_id: number;
    start_time: number;
    title: string | null;
    session_number: number | null;
}

function getCompletedSessions(campaignId: number): SessionInfo[] {
    return db.prepare(`
        SELECT
            s.session_id,
            s.campaign_id,
            s.title,
            s.session_number,
            MIN(r.timestamp) as start_time
        FROM sessions s
        JOIN recordings r ON r.session_id = s.session_id
        WHERE r.status = 'PROCESSED'
        AND r.transcription_text IS NOT NULL
        AND s.campaign_id = @campaignId
        GROUP BY s.session_id
        HAVING COUNT(*) > 0
        ORDER BY start_time ASC
    `).all({ campaignId }) as SessionInfo[];
}

export const publishAllCommand: Command = {
    name: 'pubblica_tutto',
    category: 'dev',
    descriptionKey: 'help.cmd.pubblica_tutto',
    aliases: ['publish_all', 'pubblica'],
    requiresCampaign: true,
    operatorOnly: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, client, activeCampaign } = ctx;
        const channel = message.channel as TextChannel;

        const campaignId = activeCampaign!.id;
        const campaignName = activeCampaign!.name;

        const sessions = getCompletedSessions(campaignId);
        if (sessions.length === 0) {
            await message.reply(t(ctx.locale, 'admin.publishNone'));
            return;
        }

        // --- CONFERMA ---
        await message.reply(t(ctx.locale, 'admin.publishConfirm', {
            campaign: campaignName,
            count: sessions.length,
        }));

        try {
            const collected = await channel.awaitMessages({
                filter: m => m.author.id === message.author.id && ['PUBLISH', 'PUBBLICA'].includes(m.content.trim().toUpperCase()),
                max: 1,
                time: 30000,
                errors: ['time']
            });
            if (collected.size === 0) return;
        } catch {
            await message.reply(t(ctx.locale, 'admin.timeoutCancelled'));
            return;
        }

        // --- ESECUZIONE ---
        const publishSessionId = `publish-${Date.now()}`;
        monitor.startSession(publishSessionId);

        const statusMsg = await channel.send(t(ctx.locale, 'admin.publishStarted', {
            campaign: campaignName,
            total: sessions.length,
        }));

        const pipelineService = new PipelineService();
        const notificationService = new NotificationService();

        let successCount = 0;
        let errorCount = 0;
        const errors: string[] = [];

        for (let i = 0; i < sessions.length; i++) {
            const session = sessions[i];
            const progress = `[${i + 1}/${sessions.length}]`;
            const sessionLabel = session.title || session.session_id.slice(0, 8);

            if (i === 0 || i === sessions.length - 1 || i % 3 === 0) {
                await statusMsg.edit(t(ctx.locale, 'admin.publishProgress', {
                    campaign: campaignName, progress, session: sessionLabel,
                    completed: successCount, errors: errorCount,
                }));
            }

            try {
                console.log(`[Pubblica] ${progress} Sessione ${session.session_id}...`);

                // Load from the DB without calling Gemini
                const result = await pipelineService.generateSessionSummary(
                    session.session_id,
                    campaignId,
                    'DM',
                    { skipAnalysis: true, skipNormalization: true }
                );

                // Summary in the Discord channel
                await notificationService.publishToDiscord(client, session.session_id, result, channel);

                // Riepilogo tecnico via mail
                await notificationService.sendEmailRecap(session.session_id, campaignId, result);

                successCount++;
                console.log(`[Pubblica] ${progress} ✅ ${session.session_id}`);

                // Pause between sessions so the channel is not flooded
                await new Promise(r => setTimeout(r, 2000));

            } catch (err: any) {
                errorCount++;
                errors.push(`${sessionLabel}: ${err.message}`);
                console.error(`[Pubblica] ${progress} ❌ ${session.session_id}:`, err.message);
                await new Promise(r => setTimeout(r, 500));
            }
        }

        // --- RISULTATO FINALE ---
        let finalMsg = t(ctx.locale, 'admin.publishComplete', {
            campaign: campaignName, success: successCount,
            total: sessions.length, errors: errorCount,
        });

        if (errors.length > 0) {
            finalMsg += `\n\n${t(ctx.locale, 'admin.errorsHeading')}\n${errors.slice(0, 5).map(e => `- ${e}`).join('\n')}`;
            if (errors.length > 5) finalMsg += `\n${t(ctx.locale, 'admin.moreErrors', { count: errors.length - 5 })}`;
        }

        await statusMsg.edit(finalMsg);

        const metrics = await monitor.endSession();
        if (metrics) {
            try {
                const { processSessionReport } = await import('../../reporter');
                await processSessionReport(metrics);
            } catch (e: any) {
                console.warn(`[Pubblica] ⚠️ Errore invio report metriche: ${e.message}`);
            }
        }
    }
};
