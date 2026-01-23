import { TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { getSessionCampaignId, db } from '../../db';
import { monitor } from '../../monitor';
import { PipelineService } from '../../publisher/services/PipelineService';
import { IngestionService } from '../../publisher/services/IngestionService';
import { NotificationService } from '../../publisher/services/NotificationService';

export const reprocessCommand: Command = {
    name: 'reprocess',
    aliases: ['riprocessa', 'regenerate'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args, client } = ctx;
        const targetSessionId = args[0];

        if (!targetSessionId) {
            await message.reply("Uso: `$riprocessa <ID_SESSIONE>` - Rigenera memoria e dati senza ritrascrivere.");
            return;
        }

        const channel = message.channel as TextChannel;
        await channel.send(`🔄 **Riprocessamento Logico** avviato per sessione \`${targetSessionId}\`...\n1. Pulizia dati derivati (Loot, Quest, Storia, RAG)...`);

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
            // 1. PULIZIA MIRATA DATI DERIVATI
            const campaignId = getSessionCampaignId(targetSessionId);
            if (!campaignId) throw new Error("Campagna non trovata per questa sessione.");

            db.prepare('DELETE FROM knowledge_fragments WHERE session_id = ?').run(targetSessionId);
            db.prepare('DELETE FROM inventory WHERE session_id = ?').run(targetSessionId);
            db.prepare('DELETE FROM quests WHERE session_id = ?').run(targetSessionId);
            db.prepare('DELETE FROM character_history WHERE session_id = ?').run(targetSessionId);
            db.prepare('DELETE FROM npc_history WHERE session_id = ?').run(targetSessionId);
            db.prepare('DELETE FROM world_history WHERE session_id = ?').run(targetSessionId);
            db.prepare('DELETE FROM bestiary WHERE session_id = ?').run(targetSessionId);
            db.prepare('DELETE FROM npc_dossier WHERE first_session_id = ?').run(targetSessionId);
            db.prepare('DELETE FROM location_atlas WHERE first_session_id = ?').run(targetSessionId);

            await channel.send(`2. Preparazione testo e Analisi Eventi...`);

            // 2. Generate Summary (Pipeline)
            const result = await pipelineService.generateSessionSummary(targetSessionId, campaignId, 'DM');

            // 3. Ingest to RAG & DB
            await ingestionService.ingestSummary(targetSessionId, result);
            ingestionService.updateSessionTitle(targetSessionId, result.title);

            // 4. Process Batch Events
            await ingestionService.processBatchEvents(campaignId, targetSessionId, result, channel);

            // 5. Publish
            await notificationService.publishToDiscord(client, targetSessionId, result, channel);
            await notificationService.sendEmailRecap(targetSessionId, campaignId, result);

            // 6. Metrics & Report
            if (monitorStartedByUs) {
                await notificationService.reportMetrics();
            } else {
                console.log(`[Riprocessa] Costi confluiti nella sessione attiva monitorata.`);
            }

            await channel.send(`✅ **Riprocessamento Completato!** Dati aggiornati.`);

        } catch (e: any) {
            console.error(`[Monitor] ❌ Errore riprocessamento:`, e);
            await channel.send(`❌ Errore riprocessamento: ${e.message}`);

            if (monitorStartedByUs) {
                await monitor.endSession();
            }
        }
    }
};
