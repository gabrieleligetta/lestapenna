/**
 * Publisher - Orchestrator (Wait & Logic)
 */

import { Client, TextChannel } from 'discord.js';
import {
    getSessionRecordings,
    getSessionCampaignId,
    getCampaignById,
    getSessionEncounteredNPCs
} from '../db';
import {
    prepareCleanText,
    generateSummary
} from '../bard';
import { normalizeSummaryNames } from '../utils/normalize';
import { audioQueue } from '../services/queue';
import { unloadTranscriptionModels } from '../workers';
import { monitor } from '../monitor';
import { processSessionReport, sendSessionRecap } from '../reporter';
import { PipelineService } from './services/PipelineService';
import { IngestionService } from './services/IngestionService';
import { NotificationService } from './services/NotificationService';
import { sessionPhaseManager } from '../services/SessionPhaseManager';
import { requestRemoteWhisperShutdown } from '../services/remoteWhisperPower';
import { t, getGuildLocale } from '../i18n';
import { recordSessionCostSummary } from '../services/sessionCostSummary';
import { runWithAiScope } from '../bard/ai/ambientScope';
import { scopeForSession } from '../bard/ai/scope';

/**
 * Waits for transcription to finish, then produces summary, RAG and publication.
 *
 * The scope is established here rather than in the callers because there are
 * nine of them and two have no command context at all: the end of a session as
 * seen by `voiceStateUpdate`, and the technical duration cap fired by a timer.
 * The most expensive phases of the whole pipeline — analyst and writer — live
 * inside this function, so it is the last point at which getting the table
 * wrong is still possible.
 */
export async function waitForCompletionAndSummarize(client: Client, sessionId: string, channel?: TextChannel): Promise<void> {
    const scope = scopeForSession(sessionId);
    if (scope) return runWithAiScope(scope, () => runCompletionAndSummarize(client, sessionId, channel));
    return runCompletionAndSummarize(client, sessionId, channel);
}

async function runCompletionAndSummarize(client: Client, sessionId: string, channel?: TextChannel): Promise<void> {
    const CHECK_INTERVAL = 10000; // 10s check
    const MAX_WAIT_TIME = 86400000; // 24h
    const startTime = Date.now();

    console.log(`[Monitor] ⏳ In attesa completamento sessione ${sessionId}...`);

    // Initialize services
    const pipelineService = new PipelineService();
    const ingestionService = new IngestionService();
    const notificationService = new NotificationService();

    while (true) {
        // 1. Check Timeout
        if (Date.now() - startTime > MAX_WAIT_TIME) {
            console.error(`[Monitor] ⏱️ Timeout sessione ${sessionId} (24h superate)`);
            const metrics = await monitor.endSession();
            recordSessionCostSummary(sessionId, 'FAILED', metrics?.costMetrics);
            if (channel) {
                await channel.send(t(getGuildLocale(channel.guild.id), 'publish.timeout', { id: sessionId }));
            }
            throw new Error('Wait Timeout');
        }

        // 1b. Session marked ERROR by the recorder's safety net (mix/enqueue failed):
        // no point polling for 24h — warn immediately and stop.
        const phaseInfo = sessionPhaseManager.getPhase(sessionId);
        if (phaseInfo?.phase === 'ERROR') {
            console.error(`[Monitor] ❌ Sessione ${sessionId} marcata ERROR durante l'attesa. Interrompo.`);
            const metrics = await monitor.endSession();
            recordSessionCostSummary(sessionId, 'FAILED', metrics?.costMetrics);
            if (channel) {
                await channel.send(t(getGuildLocale(channel.guild.id), 'publish.mixFailed', { id: sessionId }));
            }
            throw new Error('Session marked as ERROR during wait');
        }

        // 2. Check Database State
        const recordings = getSessionRecordings(sessionId);
        const pending = recordings.filter(r => ['PENDING', 'SECURED', 'QUEUED', 'PROCESSING', 'TRANSCRIBED'].includes(r.status));
        const errors = recordings.filter(r => r.status === 'ERROR');

        if (pending.length > 0) {
            // Still processing
            await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
            continue;
        }

        // 3. All files processed (or errored) -> Proceed to finalization
        console.log(`[Monitor] ✅ Sessione ${sessionId}: Tutti i file processati.`);

        // 4. Force model unload (Blocking) - via PipelineService
        await pipelineService.unloadModels();

        if (errors.length > 0) {
            console.warn(`[Monitor] ⚠️ ${errors.length} file con errori durante la sessione.`);
        }

        // 5. Generate Summary and RAG
        const campaignId = getSessionCampaignId(sessionId);
        // Resolved from the session, NOT from the channel: on the recovery path `channel`
        // is undefined and the old guild lookup silently skipped processBatchEvents.
        const activeCampaign = campaignId ? getCampaignById(campaignId) : undefined;

        if (!campaignId) {
            console.error(`[Monitor] ❌ Nessuna campagna per sessione ${sessionId}`);
            const metrics = await monitor.endSession();
            recordSessionCostSummary(sessionId, 'FAILED', metrics?.costMetrics);
            throw new Error('No campaign found');
        }

        if (channel) {
            await channel.send(t(getGuildLocale(channel.guild.id), 'publish.transcriptionDone'));
        }

        try {
            // 📍 PHASE: SUMMARIZING
            sessionPhaseManager.setPhase(sessionId, 'SUMMARIZING');
            const result = await pipelineService.generateSessionSummary(sessionId, campaignId);

            // 📍 PHASE: INGESTING (RAG base ingestion & DB Sync)
            sessionPhaseManager.setPhase(sessionId, 'INGESTING');

            // First process and validate all batch events (Loot, NPCs, Monsters, Atlas, etc.)
            // and sync them to RAG
            if (activeCampaign) {
                await ingestionService.processBatchEvents(campaignId, sessionId, result, channel);
            }

            // Then ingest the final narrative summary into RAG
            // This ensures entity references (like new NPC IDs) are valid in DB
            await ingestionService.ingestSummary(sessionId, result);
            ingestionService.updateSessionTitle(sessionId, result.title);

            // Get encountered NPCs for publishing
            const encounteredNPCs = getSessionEncounteredNPCs(sessionId);

            // 📍 PHASE: PUBLISHING
            sessionPhaseManager.setPhase(sessionId, 'PUBLISHING');
            if (channel) {
                await notificationService.publishToDiscord(
                    client,
                    sessionId,
                    result,
                    channel
                );
            }

            // Send email report via NotificationService
            await notificationService.sendEmailRecap(sessionId, campaignId, result);

            // Send session metrics via NotificationService
            const metrics = await notificationService.reportMetrics();
            recordSessionCostSummary(sessionId, 'COMPLETED', metrics?.costMetrics);

            // Test session notification
            if (sessionId.startsWith("test-") && channel) {
                await channel.send(t(getGuildLocale(channel.guild.id), 'publish.testReportSent'));
            }

            // 📍 PHASE: DONE
            sessionPhaseManager.setPhase(sessionId, 'DONE');
            console.log(`[Monitor] ✅ Sessione ${sessionId} conclusa con successo.`);
            await requestRemoteWhisperShutdown(sessionId);
            return; // Success exit

        } catch (err: any) {
            console.error(`[Monitor] ❌ Errore fase finale riassunto:`, err);
            const metrics = await monitor.endSession();
            recordSessionCostSummary(sessionId, 'FAILED', metrics?.costMetrics);
            sessionPhaseManager.markFailed(sessionId, err.message);
            if (channel) {
                await channel.send(t(getGuildLocale(channel.guild.id), 'publish.summaryError', { error: err.message }));
            }
            throw err;
        }
    }
}
