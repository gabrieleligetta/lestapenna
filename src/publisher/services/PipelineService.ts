/**
 * Pipeline Service - Session completion polling and flow control
 */

import { TextChannel } from 'discord.js';
import { getSessionRecordings, getSessionCampaignId } from '../../db';
import { prepareCleanText, generateSummary, ToneKey } from '../../bard';
import { normalizeSummaryNames } from '../../utils/normalize';
import { audioQueue } from '../../services/queue';
import { unloadTranscriptionModels } from '../../workers';

export class PipelineService {
    private readonly CHECK_INTERVAL = 10000; // 10s
    private readonly MAX_WAIT_TIME = 86400000; // 24h

    /**
     * Waits for session processing to complete
     */
    async waitForSessionCompletion(sessionId: string, channel?: TextChannel): Promise<void> {
        const startTime = Date.now();
        console.log(`[Monitor] ⏳ In attesa completamento sessione ${sessionId}...`);

        while (true) {
            // 1. Check Timeout
            if (Date.now() - startTime > this.MAX_WAIT_TIME) {
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
                await new Promise(resolve => setTimeout(resolve, this.CHECK_INTERVAL));
                continue;
            }

            // 3. All files processed
            console.log(`[Monitor] ✅ Sessione ${sessionId}: Tutti i file processati.`);

            if (errors.length > 0) {
                console.warn(`[Monitor] ⚠️ ${errors.length} file con errori durante la sessione.`);
            }

            return; // Exit polling loop
        }
    }

    /**
     * Unloads transcription models to free memory
     */
    async unloadModels(): Promise<void> {
        console.log(`[Monitor] ⏸️ Pausa coda audio per unload modello...`);
        await audioQueue.pause();
        try {
            await unloadTranscriptionModels();
        } catch (e: any) {
            console.warn(`[Monitor] ⚠️ Errore durante unload modello: ${e.message}`);
        } finally {
            console.log(`[Monitor] ▶️ Ripresa coda audio...`);
            await audioQueue.resume();
        }
    }

    /**
     * Generates summary for the session
     */
    async generateSessionSummary(sessionId: string, campaignId: number, tone: ToneKey = 'DM', options: { skipAnalysis?: boolean } = {}): Promise<any> {
        const cleanText = prepareCleanText(sessionId);
        if (!cleanText) {
            console.warn(`[Pipeline] ⚠️ Clean text non disponibile, fallback a raw transcription gestito da generateSummary.`);
        }

        console.log(`[Pipeline] 📝 Avvio generateSummary (Tone: ${tone}, Options: ${JSON.stringify(options)})...`);
        let result = await generateSummary(sessionId, tone, cleanText, options);
        console.log(`[Pipeline] ✅ generateSummary completato, avvio normalizzazione...`);

        // Normalize entity names if campaign exists
        if (campaignId) {
            result = await normalizeSummaryNames(campaignId, result);
            console.log(`[Pipeline] ✅ Normalizzazione completata.`);
        }

        return result;
    }
}
