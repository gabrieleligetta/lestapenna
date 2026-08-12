import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthenticatedRequest } from '../auth/types';
import { canWriteCampaign } from '../../services/campaignAccess';

/**
 * Authorizes writing to campaign data: members of the table (master or
 * players) plus the server's administrators.
 *
 * Replaces the old `CampaignManageGuard`, which required the Discord
 * ManageGuild permission: that is per-server and not per-campaign, so someone
 * playing at the table could not even fix a wrong AI description.
 *
 * It covers every write to campaign data, including the actions that invoke a
 * paid model (quest lifecycle audit): the spend belongs to the table, and
 * members of the table can authorize it. The genuinely heavy operations —
 * deleting a campaign, wipes, full regenerations — do not go through here:
 * they live on the bot and are reserved for operators (`utils/permissions.ts`).
 *
 * It must run after `CampaignAccessGuard`, which is what verifies membership of
 * the guild that owns the campaign and populates `campaignId`/`guildAccess`.
 */
@Injectable()
export class CampaignWriteGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
        const campaignId = request.campaignId;
        const userId = request.webSession?.discordUserId;

        if (!campaignId || !userId) {
            throw new ForbiddenException('Campaign access has not been resolved');
        }

        const allowed = canWriteCampaign(campaignId, userId, {
            guildCanManage: request.guildAccess?.canManage ?? false,
        });
        if (!allowed) {
            throw new ForbiddenException('You must be part of this campaign to change it');
        }
        return true;
    }
}
