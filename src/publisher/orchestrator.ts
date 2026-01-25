/**
 * Publisher - Orchestrator (Wait & Logic)
 */

import { Client, TextChannel } from 'discord.js';
import {
    getSessionRecordings,
    getSessionCampaignId,
    getCampaigns,
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
import { publishSummary } from './discord';
import { PipelineService } from './services/PipelineService';
import { IngestionService } from './services/IngestionService';
import { NotificationService } from './services/NotificationService';
import { sessionPhaseManager } from '../services/SessionPhaseManager';

export async function waitForCompletionAndSummarize(client: Client, sessionId: string, channel?: TextChannel): Promise<void> {
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
            if (channel) {
                await channel.send(`⚠️ Timeout sessione \`${sessionId}\`. Elaborazione interrotta.`);
            }
            throw new Error('Wait Timeout');
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
        const activeCampaign = campaignId ? getCampaigns(channel?.guild.id || '').find(c => c.id === campaignId) : undefined;

        if (!campaignId) {
            console.error(`[Monitor] ❌ Nessuna campagna per sessione ${sessionId}`);
            throw new Error('No campaign found');
        }

        if (channel) {
            await channel.send(`📝 Trascrizione completata. Generazione riassunto finale...`);
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
            await notificationService.reportMetrics();

            // Test session notification
            if (sessionId.startsWith("test-") && channel) {
                await channel.send("✅ Report sessione di test inviato via email!");
            }

            // 📍 PHASE: DONE
            sessionPhaseManager.setPhase(sessionId, 'DONE');
            console.log(`[Monitor] ✅ Sessione ${sessionId} conclusa con successo.`);
            return; // Success exit

        } catch (err: any) {
            console.error(`[Monitor] ❌ Errore fase finale riassunto:`, err);
            sessionPhaseManager.markFailed(sessionId, err.message);
            if (channel) {
                await channel.send(`❌ Errore generazione riassunto: ${err.message}`);
            }
            throw err;
        }
    }
}
