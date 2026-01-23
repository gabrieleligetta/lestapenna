/**
 * Notification Service - Discord and Email notifications
 */

import { Client, TextChannel } from 'discord.js';
import { getSessionEncounteredNPCs } from '../../db';
import { monitor } from '../../monitor';
import { processSessionReport, sendSessionRecap } from '../../reporter';
import { publishSummary } from '../discord';

export class NotificationService {
    /**
     * Publishes summary to Discord channel
     */
    async publishToDiscord(
        client: Client,
        sessionId: string,
        summary: any,
        channel: TextChannel
    ): Promise<void> {
        const encounteredNPCs = getSessionEncounteredNPCs(sessionId);

        await publishSummary(
            client,
            sessionId,
            summary.log || [],
            channel,
            false,
            summary.title,
            summary.loot,
            summary.quests,
            summary.narrativeBrief,
            summary.monsters,
            encounteredNPCs
        );
    }

    /**
     * Sends email recap of the session
     */
    async sendEmailRecap(sessionId: string, campaignId: number, summary: any): Promise<void> {
        await sendSessionRecap(
            sessionId,
            campaignId,
            summary.log || [],
            summary.loot,
            summary.loot_removed,
            summary.narrativeBrief,
            summary.narrative,
            summary.monsters
        );
    }

    /**
     * Reports session metrics
     */
    async reportMetrics(): Promise<void> {
        const metrics = await monitor.endSession();
        if (metrics) {
            try {
                await processSessionReport(metrics);
            } catch (e: any) {
                console.error('[Monitor] ❌ ERRORE INVIO REPORT:', e.message);
            }
        }
    }

    /**
     * Sends test completion notification
     */
    async notifyTestCompletion(sessionId: string, channel: TextChannel): Promise<void> {
        if (sessionId.startsWith("test-")) {
            await channel.send("✅ Report sessione di test inviato via email!");
        }
    }
}
