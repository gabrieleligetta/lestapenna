import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { runWithAiScope } from '../../bard/ai/ambientScope';
import { AuthenticatedRequest } from './types';

/**
 * Carries the table's AI scope into the HTTP request.
 *
 * Interceptors run **after** the guards, so `request.guildAccess` has already
 * been filled by `GuildAccessGuard` or by `CampaignAccessGuard` — which derive
 * it respectively from the `:guildId` parameter and from the guild that owns
 * the campaign. Nothing is read from the body: the guild that pays must never
 * be a value chosen by the caller.
 *
 * Registered globally rather than route by route: an AI route added tomorrow
 * without remembering this interceptor would resolve the instance scope, which
 * on a public instance means the operator's key. Where `guildAccess` is absent
 * — the public routes, the login — no store is entered and only the instance
 * configuration remains.
 */
@Injectable()
export class AiScopeInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        if (context.getType() !== 'http') return next.handle();

        const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
        const guildId = request.guildAccess?.guildId;
        if (!guildId) return next.handle();

        return runWithAiScope(
            { guildId, campaignId: request.campaignId },
            () => next.handle(),
        );
    }
}
