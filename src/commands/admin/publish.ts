/**
 * $pubblica_tutto - Pubblica i riassunti di tutte le sessioni nel canale
 * usando i dati già presenti in DB (nessuna chiamata AI).
 * Invia anche il riepilogo tecnico via mail per ogni sessione.
 */

import { TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { db } from '../../db';
import { isGuildAdmin } from '../../utils/permissions';
import { PipelineService } from '../../publisher/services/PipelineService';
import { NotificationService } from '../../publisher/services/NotificationService';
import { monitor } from '../../monitor';

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
    aliases: ['publish_all', 'pubblica'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, client, activeCampaign } = ctx;
        const channel = message.channel as TextChannel;

        if (!isGuildAdmin(message.author.id, message.guild!.id)) {
            await message.reply("Solo l'admin del server può eseguire questo comando.");
            return;
        }

        const campaignId = activeCampaign!.id;
        const campaignName = activeCampaign!.name;

        const sessions = getCompletedSessions(campaignId);
        if (sessions.length === 0) {
            await message.reply("Nessuna sessione completata trovata per questa campagna.");
            return;
        }

        // --- CONFERMA ---
        await message.reply(
            `📢 **PUBBLICA TUTTO** — *${campaignName}*\n\n` +
            `Verranno pubblicati i riassunti di **${sessions.length} sessioni** nel canale corrente ` +
            `e inviati i riepiloghi tecnici via mail.\n` +
            `⚠️ Nessuna chiamata AI — usa i dati già in DB.\n\n` +
            `Scrivi \`PUBBLICA\` entro 30 secondi per procedere.`
        );

        try {
            const collected = await channel.awaitMessages({
                filter: m => m.author.id === message.author.id && m.content.toUpperCase() === 'PUBBLICA',
                max: 1,
                time: 30000,
                errors: ['time']
            });
            if (collected.size === 0) return;
        } catch {
            await message.reply("⌛ Tempo scaduto. Comando annullato.");
            return;
        }

        // --- ESECUZIONE ---
        const publishSessionId = `publish-${Date.now()}`;
        monitor.startSession(publishSessionId);

        const statusMsg = await channel.send(
            `📢 **PUBBLICAZIONE IN CORSO** — *${campaignName}*\n\n` +
            `⏳ 0/${sessions.length} sessioni pubblicate...`
        );

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
                await statusMsg.edit(
                    `📢 **PUBBLICAZIONE IN CORSO** — *${campaignName}*\n\n` +
                    `⏳ ${progress} **${sessionLabel}**...\n` +
                    `Completate: ${successCount} | Errori: ${errorCount}`
                );
            }

            try {
                console.log(`[Pubblica] ${progress} Sessione ${session.session_id}...`);

                // Carica da DB senza chiamare Gemini
                const result = await pipelineService.generateSessionSummary(
                    session.session_id,
                    campaignId,
                    'DM',
                    { skipAnalysis: true, skipNormalization: true }
                );

                // Riassunto nel canale Discord
                await notificationService.publishToDiscord(client, session.session_id, result, channel);

                // Riepilogo tecnico via mail
                await notificationService.sendEmailRecap(session.session_id, campaignId, result);

                successCount++;
                console.log(`[Pubblica] ${progress} ✅ ${session.session_id}`);

                // Pausa tra sessioni per non inondare il canale
                await new Promise(r => setTimeout(r, 2000));

            } catch (err: any) {
                errorCount++;
                errors.push(`${sessionLabel}: ${err.message}`);
                console.error(`[Pubblica] ${progress} ❌ ${session.session_id}:`, err.message);
                await new Promise(r => setTimeout(r, 500));
            }
        }

        // --- RISULTATO FINALE ---
        let finalMsg =
            `✅ **PUBBLICAZIONE COMPLETATA** — *${campaignName}*\n\n` +
            `- Sessioni pubblicate: **${successCount}/${sessions.length}**\n` +
            `- Errori: **${errorCount}**`;

        if (errors.length > 0) {
            finalMsg += `\n\n**Errori:**\n${errors.slice(0, 5).map(e => `- ${e}`).join('\n')}`;
            if (errors.length > 5) finalMsg += `\n... e altri ${errors.length - 5} errori`;
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
