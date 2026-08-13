import { CommandContext } from '../types';
import { checkAiReadiness } from '../../bard/ai/readiness';
import { config } from '../../config';
import { t } from '../../i18n';

/**
 * Does the table have its own AI keys?
 *
 * Lestapenna is BYOK: nobody pays for anyone else, so a table that has not
 * configured its own keys simply cannot use AI. The point is **to say so
 * beforehand**: a recording started without keys becomes audio nobody will
 * transcribe, and at that point the session really is lost.
 *
 * Returns `true` when it is safe to proceed; otherwise it has already replied
 * and the command must stop — same shape as `assertCampaignWrite`.
 */
export async function assertAiConfigured(ctx: CommandContext): Promise<boolean> {
    const readiness = checkAiReadiness({
        guildId: ctx.guildId,
        campaignId: ctx.activeCampaign?.id,
    });
    if (readiness.ready) return true;

    // The guided path, not the settings page: whoever reaches this message has
    // nothing configured, and the six sections of `/ai` are exactly what they
    // could not get through on their own. `/setup` walks the same endpoints in
    // the order they depend on, and links back to `/ai` from every step.
    const settingsUrl = `${config.discordOAuth.publicBaseUrl}/app/guilds/${ctx.guildId}/setup`;

    // Two different gaps, two different remedies: without a transcription engine
    // there is no point getting just any key, you have to choose between your own
    // PC and a cloud model. Saying it generically would send the user looking for
    // the wrong thing.
    if (!readiness.canTranscribe) {
        await ctx.message.reply(t(ctx.locale, 'ai.transcriptionNotConfigured', { url: settingsUrl }));
        return false;
    }

    await ctx.message.reply(t(ctx.locale, 'ai.notConfigured', {
        providers: readiness.providers.join(', '),
        url: settingsUrl,
    }));
    return false;
}
