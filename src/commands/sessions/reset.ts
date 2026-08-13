import { Command, CommandContext } from '../types';
import { TextChannel } from 'discord.js';
import { getSessionGuildId, resetSessionData, updateRecordingStatus } from '../../db';
import { removeSessionJobs } from '../../services/queue';
import { downloadFromOracle, uploadToOracle } from '../../services/backup';
import { purgeSessionData } from '../../services/janitor';
import { enqueueSessionProcessing } from '../../services/sessionProcessing';
import * as fs from 'fs';
import { t } from '../../i18n';
import { assertSessionInGuild } from '../utils/sessionScope';

export const resetCommand: Command = {
    name: 'reset',
    category: 'sessione',
    descriptionKey: 'help.cmd.reset',
    aliases: ['resetsession'],
    requiresCampaign: false,
    operatorOnly: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args } = ctx;

        const targetSessionId = args[0];

        if (!targetSessionId) {
            await message.reply(t(ctx.locale, 'session.resetUsage'));
            return;
        }

        // operatorOnly limits WHO may run it, not WHAT on: without this, an
        // operator could wipe another server's session.
        if (!await assertSessionInGuild(ctx, targetSessionId)) return;

        await message.reply(t(ctx.locale, 'session.resetStarted', { id: targetSessionId }));

        const removed = await removeSessionJobs(targetSessionId);

        // 1.5 Purge Derived Data (DB + RAG + Clean Bio State + AI Cache)
        purgeSessionData(targetSessionId, true); // 🆕 Clear cache on full reset

        const filesToProcess = resetSessionData(targetSessionId);

        if (filesToProcess.length === 0) {
            await message.reply(t(ctx.locale, 'session.resetNoFiles', { id: targetSessionId }));
            return;
        }

        await message.reply(t(ctx.locale, 'session.resetProgress', { n: filesToProcess.length }));

        let restoredCount = 0;

        for (const job of filesToProcess) {
            if (!fs.existsSync(job.filepath)) {
                const success = await downloadFromOracle(job.filename, job.filepath, targetSessionId);
                if (success) restoredCount++;
            }

            try {
                const uploaded = await uploadToOracle(job.filepath, job.filename, targetSessionId);
                if (uploaded) {
                    updateRecordingStatus(job.filename, 'SECURED');
                }
            } catch (err) {
                console.error(`[Custode] Fallimento upload durante reset per ${job.filename}:`, err);
            }

        }

        // The queue must not be resumed here — the recording counter handles pause/resume

        let statusMsg = t(ctx.locale, 'session.resetQueued', { n: filesToProcess.length });
        if (restoredCount > 0) {
            statusMsg += t(ctx.locale, 'session.resetRestored', { n: restoredCount });
        }
        await message.reply(statusMsg);

        try {
            const guildId = getSessionGuildId(targetSessionId)!;
            await enqueueSessionProcessing(targetSessionId, guildId, message.channel.id);
        } catch (e: any) {
            console.error(`[Reset] Errore nell'accodamento:`, e);
            const channel = message.channel as TextChannel;
            await channel.send(t(ctx.locale, 'session.resetError', { message: e.message }));
        }
    }
};
