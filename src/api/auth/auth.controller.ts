import {
    Controller,
    Get,
    Post,
    Query,
    Req,
    Res,
    ServiceUnavailableException,
    UseGuards,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { randomBytes } from 'crypto';
import { config } from '../../config';
import { DiscordOAuthService } from './discordOAuth.service';
import { storeOAuthAttempt, consumeOAuthAttempt, createWebSession, destroyWebSession } from './webSession.store';
import { SessionGuard } from './session.guard';
import { SESSION_COOKIE_NAME } from './session.guard';
import { AuthenticatedRequest } from './types';
import { logger } from '../../utils/logger';

const log = logger('AuthController');

const OAUTH_STATE_COOKIE = 'lp_oauth_state';
const OAUTH_STATE_PATH = '/api/v1/auth/discord';
// Production remains HTTPS-only. Local Vite previews use an http://localhost
// callback, where a Secure cookie would be discarded by some browsers before
// Discord returns with the CSRF state.
const SECURE_OAUTH_COOKIES = new URL(config.discordOAuth.redirectUri).protocol === 'https:';

@Controller('api/v1/auth')
export class AuthController {
    constructor(private readonly discordOAuth: DiscordOAuthService) {}

    @Get('discord')
    async startLogin(@Res() reply: FastifyReply) {
        if (!config.discordOAuth.clientId || !config.discordOAuth.clientSecret) {
            throw new ServiceUnavailableException('Discord login non configurato su questo ambiente');
        }

        const state = this.discordOAuth.generateState();
        const { verifier, challenge } = this.discordOAuth.generatePkce();
        await storeOAuthAttempt(state, { codeVerifier: verifier });

        reply.setCookie(OAUTH_STATE_COOKIE, state, {
            httpOnly: true,
            secure: SECURE_OAUTH_COOKIES,
            sameSite: 'lax',
            path: OAUTH_STATE_PATH,
            maxAge: 600,
        });

        return reply.redirect(this.discordOAuth.buildAuthorizeUrl(state, challenge), 302);
    }

    @Get('discord/callback')
    async callback(
        @Query('code') code: string | undefined,
        @Query('state') state: string | undefined,
        @Req() request: AuthenticatedRequest,
        @Res() reply: FastifyReply,
    ) {
        const cookieState = (request.cookies ?? {})[OAUTH_STATE_COOKIE];
        reply.clearCookie(OAUTH_STATE_COOKIE, { path: OAUTH_STATE_PATH });

        if (!code || !state || !cookieState || cookieState !== state) {
            log.warn('OAuth callback rejected: missing/mismatched state');
            return reply.redirect('/app/?login=error', 302);
        }

        const attempt = await consumeOAuthAttempt(state);
        if (!attempt) {
            log.warn('OAuth callback rejected: unknown/expired/reused state');
            return reply.redirect('/app/?login=error', 302);
        }

        try {
            const tokens = await this.discordOAuth.exchangeCode(code, attempt.codeVerifier);
            const [user, guilds] = await Promise.all([
                this.discordOAuth.fetchUser(tokens.accessToken),
                this.discordOAuth.fetchGuilds(tokens.accessToken),
            ]);

            const sessionId = randomBytes(32).toString('hex');
            await createWebSession(sessionId, {
                discordUserId: user.id,
                username: user.username,
                globalName: user.globalName,
                avatar: user.avatar,
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                tokenExpiresAt: tokens.expiresAt,
                guilds,
                guildsFetchedAt: Date.now(),
            });

            reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
                httpOnly: true,
                secure: SECURE_OAUTH_COOKIES,
                sameSite: 'lax',
                path: '/',
                maxAge: config.discordOAuth.sessionTtlSeconds,
            });

            // The SPA login gate forwards an authenticated session on to /guilds.
            return reply.redirect('/app/', 302);
        } catch (err) {
            log.error('OAuth callback failed', err as Error);
            return reply.redirect('/app/?login=error', 302);
        }
    }

    @Post('logout')
    @UseGuards(SessionGuard)
    async logout(@Req() request: AuthenticatedRequest, @Res() reply: FastifyReply) {
        await this.discordOAuth.revokeToken(request.webSession.refreshToken);
        await destroyWebSession(request.webSessionId);
        reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
        return reply.status(200).send({ loggedOut: true });
    }
}
