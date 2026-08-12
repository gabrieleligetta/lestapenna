import { createWebSession, WebSessionData } from '../../src/api/auth/webSession.store';
import { recordLegalAcceptance } from '../../src/services/legalAcceptance';

/**
 * A logged-in user who has also accepted the current legal documents.
 *
 * `SessionGuard` refuses every authenticated route to a user who has not, which
 * is the point of it: the acceptance used to be checked only by `LegalGate.tsx`
 * in the SPA, so calling the API directly walked straight past it.
 *
 * Tests about anything other than the gate itself want a user who is past it, so
 * they use this instead of `createWebSession` — otherwise every one of them
 * would be asserting on a 403 from the gate rather than on the endpoint it was
 * written for. The gate's own behaviour is pinned in `tests/unit/saas/auth.test.ts`.
 */
export async function signIn(cookie: string, session: WebSessionData): Promise<void> {
    await createWebSession(cookie, session);
    recordLegalAcceptance(session.discordUserId, ['terms', 'privacy']);
}
