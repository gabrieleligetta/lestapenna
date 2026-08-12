import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { SessionAccessService } from './sessionAccess.service';
import { AuthenticatedRequest } from './types';
import { needsLegalAcceptance } from '../../services/legalAcceptance';

export const SESSION_COOKIE_NAME = 'lp_session';

/**
 * Route prefixes reachable without having accepted the current documents.
 *
 * The line is between **identity** and **the archive**. `/me/*` is how a client
 * learns who it is, what is still unaccepted and where it can go — gating it
 * would lock everyone out of the very screen that unlocks the rest — and
 * `/auth/*` has to keep working because leaving must never require agreeing to
 * something first. Everything else reaches recordings, transcripts and campaign
 * data, and that is what the gate is for.
 */
const LEGAL_EXEMPT_PREFIXES = ['/api/v1/me', '/api/v1/auth'];

@Injectable()
export class SessionGuard implements CanActivate {
    constructor(private readonly sessionAccess: SessionAccessService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
        const sessionId = (request.cookies ?? {})[SESSION_COOKIE_NAME];
        if (!sessionId) {
            throw new UnauthorizedException('Not logged in');
        }

        const session = await this.sessionAccess.loadSession(sessionId);
        if (!session) {
            throw new UnauthorizedException('Session expired');
        }

        request.webSessionId = sessionId;
        request.webSession = session;

        /*
         * The legal gate, enforced here rather than in the SPA.
         *
         * `needsLegalAcceptance()` existed and was exported but had **no call
         * site anywhere**: the only thing standing between an un-accepted user
         * and the whole API was `LegalGate.tsx`, a React component, which anyone
         * bypasses by calling the endpoint directly. A gate that only the honest
         * client honours is not a gate.
         *
         * It lives in SessionGuard, not in a guard of its own, so that it covers
         * every authenticated route automatically — including the ones nobody
         * has written yet, which is where the next hole would otherwise appear.
         */
        const path = (request.url ?? '').split('?')[0].replace(/\/+$/, '') || '/';
        const exempt = LEGAL_EXEMPT_PREFIXES.some(p => path === p || path.startsWith(`${p}/`));
        if (!exempt && needsLegalAcceptance(session.discordUserId)) {
            throw new ForbiddenException('Legal acceptance required');
        }

        return true;
    }
}
