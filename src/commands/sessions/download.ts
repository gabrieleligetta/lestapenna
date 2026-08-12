import { TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { getPresignedUrl } from '../../services/backup';
import { mixSessionAudio } from '../../services/sessionMixer';
import { audioQueue } from '../../services/queue';
import * as fs from 'fs';
import * as path from 'path';
import { hasActiveSession } from '../../state/sessionState';
import { t } from '../../i18n';
import { assertSessionInGuild } from '../utils/sessionScope';

export const downloadCommand: Command = {
    name: 'download',
    category: 'sessione',
    descriptionKey: 'help.cmd.download',
    aliases: ['scarica'],
    requiresCampaign: false,
    // Rebuilds the whole session's master audio and publishes a signed link to
    // it: this is the recorded voices of the entire table, not a lookup command.
    adminOnly: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args } = ctx;

        const isActiveSession = await hasActiveSession(message.guild!.id);
        const queueCounts = await audioQueue.getJobCounts();
        const isProcessing = queueCounts.active > 0 || queueCounts.waiting > 0;

        if (isActiveSession || isProcessing) {
            await message.reply(t(ctx.locale, 'session.dlBusy', {
                active: t(ctx.locale, isActiveSession ? 'common.yes' : 'common.no'),
                processing: t(ctx.locale, isProcessing ? 'common.yes' : 'common.no'),
                queued: queueCounts.waiting,
            }));
            return;
        }

        let targetSessionId = args[0];
        let force = false;
        let keep = false;

        // Parse arguments
        for (const arg of args) {
            if (arg === 'force' || arg === '--force') force = true;
            else if (arg === 'keep' || arg === '--keep') keep = true;
            else if (!targetSessionId) targetSessionId = arg;
        }

        if (!targetSessionId) {
            // No active session (checked above) → the user has to give the ID.
            await message.reply(t(ctx.locale, 'session.dlSpecifyId'));
            return;
        }

        // The id comes from the user and from here on becomes a bucket key and
        // a signed link valid for 24 hours: without this check, knowing another
        // table's id was enough to download its audio.
        if (!await assertSessionInGuild(ctx, targetSessionId)) return;

        // Check if already exists in cloud
        const finalFileName = `session_${targetSessionId}_master.mp3`;
        const cloudKey = `recordings/${targetSessionId}/${finalFileName}`;

        // If not force, check if exists
        if (!force) {
            const existingUrl = await getPresignedUrl(cloudKey, undefined, 3600 * 24);
            if (existingUrl) {
                await (message.channel as TextChannel).send(t(ctx.locale, 'session.dlAlready', { url: existingUrl, id: targetSessionId }));
                return;
            }
        }

        await message.reply(t(ctx.locale, 'session.dlProcessing', { id: targetSessionId }));

        try {
            const filePath = await mixSessionAudio(targetSessionId, keep);

            const stats = fs.statSync(filePath);
            const sizeMB = stats.size / (1024 * 1024);

            if (sizeMB < 25) {
                await (message.channel as TextChannel).send({
                    content: t(ctx.locale, 'session.dlReady', { size: sizeMB.toFixed(2) }),
                    files: [filePath]
                });
            } else {
                const presignedUrl = await getPresignedUrl(cloudKey, undefined, 3600 * 24);

                if (presignedUrl) {
                    await (message.channel as TextChannel).send(t(ctx.locale, 'session.dlBig', { size: sizeMB.toFixed(2), url: presignedUrl }));
                } else {
                    await (message.channel as TextChannel).send(t(ctx.locale, 'session.dlNoLink', { size: sizeMB.toFixed(2) }));
                }

                // The local master is a temporary artifact of this command (distinct from the
                // per-user source files, handled by `keep` inside mixSessionAudio) — it must be
                // cleaned up regardless once the presigned link has been uploaded.
                try { fs.unlinkSync(filePath); } catch (e) { }
            }

        } catch (err: any) {
            console.error(err);
            await (message.channel as TextChannel).send(t(ctx.locale, 'session.dlError', { message: err.message }));
        }
    }
};
