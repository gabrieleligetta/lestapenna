import { Command, CommandContext } from '../types';
import { prepareCleanText, generateSummary, ingestSessionComplete } from '../../bard';
import { normalizeSummaryNames } from '../../utils/normalize';

export const ingestCommand: Command = {
    name: 'ingest',
    aliases: ['memorizza'],
    requiresCampaign: false, // Can potentially ingest without active campaign context? Index.ts check? Index says activeCampaign required generally for commands? No, check line 2962 doesn't check activeCampaign, but verify usage.
    // Logic in index.ts: if (command === 'ingest' ...) ... generateSummary ... ingestSessionComplete.
    // generateSummary uses campaignId? generateSummary(sessionId, tone, text).
    // It seems safe.

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args } = ctx;
        const targetSessionId = args[0];
        if (!targetSessionId) {
            await message.reply("Uso: `$memorizza <ID_SESSIONE>`\nPer reingestione completa con metadati usa `$riprocessa`");
            return;
        }

        await message.reply(`🧠 **Ingestione Memoria** avviata per sessione \`${targetSessionId}\`...\nℹ️ Usa \`$riprocessa\` per reingestione completa con metadati.`);

        try {
            // Ingestione semplificata: prepara testo e genera summary per avere metadata
            const cleanText = prepareCleanText(targetSessionId);
            if (!cleanText) {
                await message.reply(`⚠️ Nessuna trascrizione trovata per la sessione.`);
                return;
            }

            // Genera summary veloce per ottenere metadata
            const result = await generateSummary(targetSessionId, 'DM', cleanText);

            // Reconcile names if campaign is available (optional but good)
            // But we might not have campaignId easily if not passed.
            // We can get it from session?
            // getSessionCampaignId(targetSessionId) is in DB.
            // But let's stick to simple logic as in index.ts. 
            // Index.ts line 2976-2977 just called generateSummary then ingestSessionComplete.

            await ingestSessionComplete(targetSessionId, result);

            await message.reply(`✅ Memoria aggiornata per sessione \`${targetSessionId}\`. Ora puoi farmi domande su di essa.`);
        } catch (e: any) {
            console.error(e);
            await message.reply(`❌ Errore durante l'ingestione: ${e.message}`);
        }
    }
};
