import { Command, CommandContext } from '../types';
import { disconnect } from '../../services/recorder';
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
            try {
                await disconnect(message.guild!.id);
            } finally {
                // A stale voice connection can outlive its Redis session after a
                // partial crash/reset. Releasing is idempotent and prevents that
                // stale admission slot from blocking another guild.
                await decrementRecordingCount(message.guild!.id);
            }
            await message.reply(t(ctx.locale, 'session.noActiveButDisconnected'));
            return;
        }

        // 1. Drop the session from Redis IMMEDIATELY — prevents the race with the auto-leave timer
        await deleteActiveSession(message.guild!.id);
        clearSessionHardCap(message.guild!.id);

        // Keep the capacity slot until every encoder is closed and its final
        // segment is secured. Otherwise another guild could enter while this
        // one still consumes the resources the slot is meant to protect.
        try {
            await disconnect(message.guild!.id, { processSession: false });
        } finally {
            await decrementRecordingCount(message.guild!.id);
        }

        const stopMsg = t(ctx.locale, 'session.stopped', { id: sessionId })
            + communityLine(ctx.guildId, ctx.locale);
        if (ctx.interaction && !ctx.interaction.replied && !ctx.interaction.deferred) {
            await ctx.interaction.update({ content: stopMsg, components: [], embeds: [] });
        } else {
            await message.reply(stopMsg);
        }

        launchSessionProcessing(sessionId, message.guild!.id, message.channel.id);
        console.log(`[Flow] Sessione terminata. I worker elaboreranno i file accumulati...`);
    }
};
