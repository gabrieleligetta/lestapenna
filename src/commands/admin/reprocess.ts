import { TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { getSessionCampaignId, db } from '../../db';
import { monitor } from '../../monitor';
import { PipelineService } from '../../publisher/services/PipelineService';
import { IngestionService } from '../../publisher/services/IngestionService';
import { NotificationService } from '../../publisher/services/NotificationService';
import { purgeSessionData } from '../../services/janitor';

export const reprocessCommand: Command = {
    name: 'reprocess',
    aliases: ['riprocessa', 'regenerate'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args, client } = ctx;
        const targetSessionId = args[0];
        const isForce = args.some(arg => arg.toUpperCase() === 'FORCE');
        const isSilent = args.some(arg => arg.toUpperCase() === 'SILENT' || arg.toUpperCase() === 'SHHH');

        if (!targetSessionId) {
            await message.reply("Uso: `$riprocessa <ID_SESSIONE> [FORCE] [SILENT]` - Rigenera memoria e dati senza ritrascrivere.");
            return;
        }

        const channel = message.channel as TextChannel;

        if (isForce) {
            await channel.send("⚠️ **MODALITÀ FORCE ATTIVA**: Verrà forzata la rigenerazione AI del riassunto.");
        } else {
            await channel.send("ℹ️ **MODALITÀ SMART**: Uso dati salvati se disponibili (Zero costi).");
        }

        if (isSilent) {
            await channel.send("🤫 **MODALITÀ SILINTE**: Notifiche Discord e Email disabilitate.");
        }

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
            // 0. CLEANUP (DB + RAG + Sync State)
            const campaignId = getSessionCampaignId(targetSessionId);
            if (!campaignId) throw new Error("Campagna non trovata per questa sessione.");

            purgeSessionData(targetSessionId);

            await channel.send(`2. Preparazione testo e Analisi Eventi...`);

            // 2. Generate Summary (Pipeline)
            const result = await pipelineService.generateSessionSummary(targetSessionId, campaignId, 'DM', { forceRegeneration: isForce });

            // 3. Ingest to RAG & DB
            await ingestionService.ingestSummary(targetSessionId, result);
            ingestionService.updateSessionTitle(targetSessionId, result.title);

            // 4. Process Batch Events
            await ingestionService.processBatchEvents(campaignId, targetSessionId, result, channel, isSilent);

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
