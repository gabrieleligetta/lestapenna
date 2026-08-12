import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthenticatedRequest } from '../auth/types';
import { canManageMembership } from '../../services/campaignAccess';

/**
 * Authorizes the governance of the table: membership and campaign
 * configuration.
 *
 * Twin of `CampaignWriteGuard` one step higher up. That one covers the game
 * data, which any member may correct; here we decide who sits at the table and
 * in which world it is played — if being a member were enough, a player could
 * remove the master and be left alone (same reasoning already written in
 * `services/campaignAccess.ts#canManageMembership`).
 *
 * It must run after `CampaignAccessGuard`, which populates `campaignId`/`guildAccess`.
 */
@Injectable()
export class CampaignMasterGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
        const campaignId = request.campaignId;
        const userId = request.webSession?.discordUserId;

        if (!campaignId || !userId) {
            throw new ForbiddenException('Campaign access has not been resolved');
        }

        const allowed = canManageMembership(campaignId, userId, {
            guildCanManage: request.guildAccess?.canManage ?? false,
        });
        if (!allowed) {
            throw new ForbiddenException('Only a campaign master can change this');
        }
        return true;
    }
}
