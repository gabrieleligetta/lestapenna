import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthenticatedRequest } from './types';

/**
 * Requires the Discord permission to manage the server.
 *
 * To be used **after** `GuildAccessGuard`, which computes `canManage` from the
 * user's real permissions on that guild.
 *
 * ⚠️ It must not be swapped for a campaign guard. A campaign master is not
 * necessarily an administrator of the server, and the API keys belong to the
 * server: that mismatch is exactly how one player's key would end up paying for
 * another campaign's sessions.
 */
@Injectable()
export class GuildManageGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
        if (!request.guildAccess?.canManage) {
            throw new ForbiddenException('You must be able to manage this server');
        }
        return true;
    }
}
