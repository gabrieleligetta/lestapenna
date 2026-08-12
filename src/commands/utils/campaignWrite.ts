import { CommandContext } from '../types';
import { canWriteCampaign } from '../../services/campaignAccess';
import { isGuildOperator } from '../../utils/permissions';
import { t } from '../../i18n';

/**
 * Removes the bot's historical ambiguity: any server member who could write in
 * the command channel could modify or delete the game world. The same rule as
 * the web now applies — you have to be part of the table.
 *
 * Returns `true` when the caller may proceed; otherwise it has already replied
 * and the command must stop. `$iam` stays outside: it is the gesture of sitting
 * down at the table, so it cannot require you to be there already.
 */
export async function assertCampaignWrite(ctx: CommandContext): Promise<boolean> {
    const campaign = ctx.activeCampaign;
    if (!campaign) {
        await ctx.message.reply(t(ctx.locale, 'dispatcher.noCampaign'));
        return false;
    }

    const allowed = canWriteCampaign(campaign.id, ctx.message.author.id, {
        guildCanManage: isGuildOperator(ctx.message.author.id, ctx.guildId, ctx.message.member),
    });
    if (!allowed) {
        await ctx.message.reply(t(ctx.locale, 'crud.notAMember', { campaign: campaign.name }));
        return false;
    }
    return true;
}
