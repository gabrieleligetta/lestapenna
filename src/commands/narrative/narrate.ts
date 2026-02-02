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

export const narrateCommand: Command = {
    name: 'narrate',
    aliases: ['racconta', 'summarize'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args, activeCampaign, client } = ctx;

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
            // Mostra sessioni della campagna attiva
            const sessions = getAvailableSessions(message.guild!.id, activeCampaign?.id);
            if (sessions.length === 0) {
                await message.reply("Nessuna sessione trovata per questa campagna.");
                return;
            }
            const list = sessions.map(s => `🆔 \`${s.session_id}\`\n📅 ${new Date(s.start_time).toLocaleString()} (${s.fragments} frammenti)`).join('\n\n');
            const embed = new EmbedBuilder().setTitle(`📜 Sessioni: ${activeCampaign?.name}`).setDescription(list);
            await message.reply({ embeds: [embed] });
            return;
        }

        if (requestedTone && !TONES[requestedTone]) {
            await message.reply(`Tono non valido. Toni: ${Object.keys(TONES).join(', ')}`);
            return;
        }

        const channel = message.channel as TextChannel;
        await channel.send(`📜 Il Bardo sta consultando gli archivi per la sessione \`${targetSessionId}\`...`);

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

            // Se è già processata e NON è richiesto reindex, saltiamo la parte di ingestione
            const shouldIngest = forceReindex || !isAlreadyProcessed;

            if (isAlreadyProcessed && !forceReindex) {
                await channel.send("ℹ️ Sessione già indicizzata (rebuild). Generazione solo riassunto (uso cache se possibile)...");
            } else if (forceReindex) {
                await channel.send("🔄 Reindicizzazione forzata richiesta (FORCE attiva).");
            }

            await channel.send("📚 Il Bardo sta preparando il testo...");
            await channel.send("✍️ Inizio stesura del racconto...");

            // 1. Prepare Flags
            // Logic:
            // - If forceReindex: Clean everything first, then run Full Analysis
            // - If NOT forceReindex (and already processed): Skip Analysis, Hydrate from DB
            // - If new session: Full Analysis (default)

            const skipAnalysis = !shouldIngest;

            if (forceReindex) {
                await channel.send("🧹 Pulizia dati sessione precedenti (Reindex)...");
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

            // 4. Publish to Discord (Sempre, è lo scopo del comando)
            await notificationService.publishToDiscord(client, targetSessionId, result, channel);

            // 5. Email Recap (Sempre)
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
            await channel.send(`⚠️ Errore durante la generazione del riassunto: ${err.message}`);

            // Se errore, e avevamo aperto il monitor, chiudiamolo comunque per pulizia
            if (monitorStartedByUs) {
                await monitor.endSession();
            }
        }
    }
};
