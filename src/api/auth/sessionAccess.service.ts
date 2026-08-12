/**
 * Keeps a loaded web session usable: refreshes the Discord access token
 * transparently when it's near expiry, and refreshes the cached guild list
 * on a short TTL. Shared by SessionGuard, GuildAccessGuard and MeController
 * so there's exactly one place that knows the refresh thresholds.
 */

import { Injectable } from '@nestjs/common';
import { DiscordOAuthService } from './discordOAuth.service';
import {
    WebSessionData,
    getWebSession,
    updateWebSession,
    destroyWebSession,
} from './webSession.store';

const TOKEN_REFRESH_MARGIN_MS = 60_000;
const GUILDS_CACHE_MAX_AGE_MS = 5 * 60_000;

@Injectable()
export class SessionAccessService {
    constructor(private readonly discordOAuth: DiscordOAuthService) {}

    /** Returns null if there is no session, or if the refresh token turned out to be revoked/invalid. */
    async loadSession(sessionId: string): Promise<WebSessionData | null> {
        const session = await getWebSession(sessionId);
        if (!session) return null;

        if (Date.now() < session.tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
            return session;
        }

        try {
            const tokens = await this.discordOAuth.refreshTokens(session.refreshToken);
            const updated: WebSessionData = {
                ...session,
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                tokenExpiresAt: tokens.expiresAt,
            };
            await updateWebSession(sessionId, updated);
            return updated;
        } catch {
            await destroyWebSession(sessionId);
            return null;
        }
    }

    async ensureGuilds(sessionId: string, session: WebSessionData): Promise<WebSessionData> {
        if (Date.now() - session.guildsFetchedAt < GUILDS_CACHE_MAX_AGE_MS) {
            return session;
        }
        const guilds = await this.discordOAuth.fetchGuilds(session.accessToken);
        const updated: WebSessionData = { ...session, guilds, guildsFetchedAt: Date.now() };
        await updateWebSession(sessionId, updated);
        return updated;
    }
}
