/**
 * `$membri` — who belongs to the campaign and in which role.
 *
 * Without this command the `campaign_members` table would be write-only:
 * `$iam` enrolls, but nobody could revoke access from someone who has left the
 * table, nor appoint a second master.
 */

import { Command, CommandContext } from '../types';
import { campaignMemberRepository } from '../../db';
import { canManageMembership, getCampaignRole } from '../../services/campaignAccess';
import { isGuildOperator } from '../../utils/permissions';
import { t } from '../../i18n';

/** Accepts a `<@123>` mention, a raw id, or nothing. */
function parseUserId(raw: string | undefined): string | null {
    if (!raw) return null;
    const match = raw.trim().match(/^<@!?(\d+)>$/) || raw.trim().match(/^(\d{5,})$/);
    return match ? match[1] : null;
}

export const membersCommand: Command = {
    name: 'members',
    category: 'campagna',
    descriptionKey: 'help.cmd.members',
    aliases: ['membri'],
    requiresCampaign: true,
    usage: [
        { usage: '$membri', descriptionKey: 'help.usage.members.list' },
        { usage: '$membri promuovi @utente', descriptionKey: 'help.usage.members.promote' },
        { usage: '$membri rimuovi @utente', descriptionKey: 'help.usage.members.remove' },
    ],

    async execute(ctx: CommandContext): Promise<void> {
        const campaign = ctx.activeCampaign!;
        const [action, target] = ctx.args;
        const privileges = {
            guildCanManage: isGuildOperator(ctx.message.author.id, ctx.guildId, ctx.message.member),
        };

        // Listing: open to whoever is at the table, it is the group's information.
        if (!action) {
            const members = campaignMemberRepository.list(campaign.id);
            if (members.length === 0) {
                await ctx.message.reply(t(ctx.locale, 'members.empty', { campaign: campaign.name }));
                return;
            }
            const lines = members.map((m) =>
                t(ctx.locale, m.role === 'MASTER' ? 'members.lineMaster' : 'members.linePlayer', { user: `<@${m.user_id}>` }));
            await ctx.message.reply(
                `${t(ctx.locale, 'members.title', { campaign: campaign.name })}\n${lines.join('\n')}`,
            );
            return;
        }

        if (!canManageMembership(campaign.id, ctx.message.author.id, privileges)) {
            await ctx.message.reply(t(ctx.locale, 'members.masterOnly'));
            return;
        }

        const userId = parseUserId(target);
        if (!userId) {
            await ctx.message.reply(t(ctx.locale, 'members.needUser'));
            return;
        }

        const verb = action.toLowerCase();

        if (['promote', 'promuovi'].includes(verb)) {
            if (getCampaignRole(campaign.id, userId) === null) {
                await ctx.message.reply(t(ctx.locale, 'members.notMember', { user: `<@${userId}>` }));
                return;
            }
            campaignMemberRepository.setRole(campaign.id, userId, 'MASTER');
            await ctx.message.reply(t(ctx.locale, 'members.promoted', { user: `<@${userId}>` }));
            return;
        }

        if (['remove', 'rimuovi'].includes(verb)) {
            // Removing the last master would leave the campaign with nobody able to
            // manage its members.
            if (getCampaignRole(campaign.id, userId) === 'MASTER'
                && campaignMemberRepository.countMasters(campaign.id) <= 1) {
                await ctx.message.reply(t(ctx.locale, 'members.lastMaster'));
                return;
            }
            const removed = campaignMemberRepository.remove(campaign.id, userId);
            await ctx.message.reply(removed
                ? t(ctx.locale, 'members.removed', { user: `<@${userId}>` })
                : t(ctx.locale, 'members.notMember', { user: `<@${userId}>` }));
            return;
        }

        await ctx.message.reply(t(ctx.locale, 'members.needUser'));
    },
};
