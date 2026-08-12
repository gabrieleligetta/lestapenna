import { CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { SessionAccessService } from '../auth/sessionAccess.service';
import { AuthenticatedRequest } from '../auth/types';
import { campaignRepository } from '../../db';

/**
 * Authorizes access to a `:campaignId` route param by resolving the
 * campaign's owning guild and checking the caller is a member of THAT guild
 * — roadmap 2.2 point 4 ("check that the campaign belongs to the same
 * guild"). Must run after SessionGuard.
 */
@Injectable()
export class CampaignAccessGuard implements CanActivate {
    constructor(private readonly sessionAccess: SessionAccessService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
        const campaignIdParam = (request.params as Record<string, string>)?.campaignId;
        const campaignId = Number(campaignIdParam);
        if (!campaignIdParam || Number.isNaN(campaignId)) {
            throw new ForbiddenException('Missing campaignId');
        }

        const campaign = campaignRepository.getCampaignById(campaignId);
        if (!campaign) {
            throw new NotFoundException('Campaign not found');
        }

        const session = await this.sessionAccess.ensureGuilds(request.webSessionId, request.webSession);
        request.webSession = session;

        const membership = session.guilds.find((g) => g.id === campaign.guild_id);
        if (!membership) {
            throw new ForbiddenException('Not a member of this campaign\'s guild');
        }

        request.guildAccess = { guildId: campaign.guild_id, canManage: membership.canManage };
        request.campaignId = campaignId;
        return true;
    }
}
