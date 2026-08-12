import { Command, CommandContext } from '../types';
import { prepareCleanText, generateSummary, ingestSessionComplete } from '../../bard';
import { normalizeSummaryNames } from '../../utils/normalize';
import { t } from '../../i18n';
import { assertSessionInGuild } from '../utils/sessionScope';

export const ingestCommand: Command = {
    name: 'ingest',
    category: 'dev',
    descriptionKey: 'help.cmd.ingest',
    aliases: ['memorizza'],
    // No active campaign needed: the session id already says which campaign it
    // belongs to.
    requiresCampaign: false,
    // Regenerates a session's recap and memory: that is AI spend on the table's
    // own keys, not a lookup.
    operatorOnly: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args } = ctx;
        const targetSessionId = args[0];
        if (!targetSessionId) {
            await message.reply(t(ctx.locale, 'narrative.ingestUsage'));
            return;
        }

        if (!await assertSessionInGuild(ctx, targetSessionId)) return;

        await message.reply(t(ctx.locale, 'narrative.ingestStarted', { id: targetSessionId }));

        try {
            // Simplified ingestion: prepare the text and generate a summary to get the metadata
            const cleanText = prepareCleanText(targetSessionId);
            if (!cleanText) {
                await message.reply(t(ctx.locale, 'narrative.ingestNoTranscript'));
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

            await message.reply(t(ctx.locale, 'narrative.ingestDone', { id: targetSessionId }));
        } catch (e: any) {
            console.error(e);
            await message.reply(t(ctx.locale, 'narrative.ingestError', { error: e.message }));
        }
    }
};
