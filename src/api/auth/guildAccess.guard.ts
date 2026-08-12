import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { SessionAccessService } from './sessionAccess.service';
import { AuthenticatedRequest } from './types';

/**
 * Authorizes access to a `:guildId` route param: the calling user must be a
 * current member of that Discord guild (per their own OAuth guild list, not
 * just "is the bot there"). Must run AFTER SessionGuard — relies on
 * request.webSession already being set.
 */
@Injectable()
export class GuildAccessGuard implements CanActivate {
    constructor(private readonly sessionAccess: SessionAccessService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
        const guildId = (request.params as Record<string, string>)?.guildId;
        if (!guildId) {
            // Misconfigured route (no :guildId param) — fail closed.
            throw new ForbiddenException('Missing guildId');
        }

        const session = await this.sessionAccess.ensureGuilds(request.webSessionId, request.webSession);
        request.webSession = session;

        const membership = session.guilds.find((g) => g.id === guildId);
        if (!membership) {
            throw new ForbiddenException('Not a member of this guild');
        }

        request.guildAccess = { guildId, canManage: membership.canManage };
        return true;
    }
}
