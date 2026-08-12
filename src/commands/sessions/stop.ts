import { TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { disconnect } from '../../services/recorder';
import { waitForCompletionAndSummarize } from '../../publisher';
import { getActiveSession, deleteActiveSession, decrementRecordingCount } from '../../state/sessionState';
import { clearSessionHardCap } from '../../services/sessionHardCap';
import { t } from '../../i18n';
import { launchSessionProcessing } from '../../services/sessionProcessing';
import { assertCampaignWrite } from '../utils/campaignWrite';
import { communityLine } from '../utils/communityLine';

export const stopCommand: Command = {
    name: 'stop',
    category: 'sessione',
    descriptionKey: 'help.cmd.stop',
    aliases: ['termina', 'stoplistening'],
    requiresCampaign: false, // Can stop even if campaign context is loose? Probably requires session check.

    async execute(ctx: CommandContext): Promise<void> {
        const { message, client } = ctx;

        // Same rule as `$pause`: ending a session is a write on the table, but
        // when no campaign is set there is nobody to be a member of, and a
        // recording that cannot be stopped is worse than one stopped by the
        // wrong person.
        if (ctx.activeCampaign && !await assertCampaignWrite(ctx)) return;

        const sessionId = await getActiveSession(message.guild!.id);

        if (!sessionId) {
            // Disconnect anyway if requested, just to be safe
            await disconnect(message.guild!.id);
            await message.reply(t(ctx.locale, 'session.noActiveButDisconnected'));
            return;
        }

        // 1. Drop the session from Redis IMMEDIATELY — prevents the race with the auto-leave timer
        await deleteActiveSession(message.guild!.id);
        clearSessionHardCap(message.guild!.id);

        // 2. Resume the queue (per session: decrement the counter, resume when nobody is recording)
        await decrementRecordingCount();

        // 3. Disconnect and back up, then start the processing.
        await disconnect(message.guild!.id, { processSession: false });

        const stopMsg = t(ctx.locale, 'session.stopped', { id: sessionId })
            + communityLine(ctx.guildId, ctx.locale);
        if (ctx.interaction && !ctx.interaction.replied && !ctx.interaction.deferred) {
            await ctx.interaction.update({ content: stopMsg, components: [], embeds: [] });
        } else {
            await message.reply(stopMsg);
        }

        launchSessionProcessing(sessionId, message.guild!.id);
        console.log(`[Flow] Sessione terminata. I worker elaboreranno i file accumulati...`);

        // 4. Monitoraggio
        await waitForCompletionAndSummarize(client, sessionId, message.channel as TextChannel);
    }
};
