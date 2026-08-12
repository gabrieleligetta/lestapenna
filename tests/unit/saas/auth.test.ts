import { createHash } from 'crypto';

jest.mock('axios');
jest.mock('../../../src/discordClient');

// No real Redis in the test environment: webSession.store opens a live
// ioredis connection at import time (same pattern as src/state/sessionState.ts).
// Fake just enough of the client (get/set/del/ttl) in memory.
jest.mock('ioredis', () => {
    const store = new Map<string, string>();
    return jest.fn().mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        get: jest.fn(async (key: string) => store.get(key) ?? null),
        set: jest.fn(async (key: string, value: string) => {
            store.set(key, value);
            return 'OK';
        }),
        del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
        ttl: jest.fn(async (key: string) => (store.has(key) ? 3600 : -2)),
    }));
});

import axios from 'axios';
import { createNestApp } from '../../../src/api/main';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyInstance } from 'fastify';
import { DiscordOAuthService } from '../../../src/api/auth/discordOAuth.service';
import * as discordClientModule from '../../../src/discordClient';

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedGetDiscordClient = discordClientModule.getDiscordClient as jest.Mock;

const FAKE_USER = { id: 'user-123', username: 'test-user', global_name: 'Test User', avatar: 'abc123' };
const MEMBER_GUILD_WITH_BOT = { id: 'guild-with-bot', name: 'Table of Heroes', icon: null, permissions: '0x20' }; // MANAGE_GUILD
const MEMBER_GUILD_WITHOUT_BOT = { id: 'guild-without-bot', name: 'Other Server', icon: null, permissions: '0' };

function tokenResponse() {
    return {
        data: {
            access_token: 'access-token-1',
            refresh_token: 'refresh-token-1',
            expires_in: 604800,
        },
    };
}

function extractCookie(setCookieHeader: string | string[] | undefined, name: string): string | undefined {
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
    for (const header of headers) {
        const match = header.match(new RegExp(`${name}=([^;]+)`));
        if (match) return match[1];
    }
    return undefined;
}

describe('Discord OAuth2 login (Fase 2.2)', () => {
    let app: NestFastifyApplication;
    let fastify: FastifyInstance;

    beforeAll(async () => {
        app = await createNestApp();
        await app.init();
        fastify = app.getHttpAdapter().getInstance();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        jest.clearAllMocks();

        mockedAxios.post.mockImplementation((url: string, body: any) => {
            if (url.includes('/oauth2/token/revoke')) {
                return Promise.resolve({ data: {} });
            }
            if (url.includes('/oauth2/token')) {
                return Promise.resolve(tokenResponse());
            }
            return Promise.reject(new Error(`Unexpected POST ${url}`));
        });

        mockedAxios.get.mockImplementation((url: string) => {
            if (url.endsWith('/users/@me/guilds')) {
                return Promise.resolve({ data: [MEMBER_GUILD_WITH_BOT, MEMBER_GUILD_WITHOUT_BOT] });
            }
            if (url.endsWith('/users/@me')) {
                return Promise.resolve({ data: FAKE_USER });
            }
            return Promise.reject(new Error(`Unexpected GET ${url}`));
        });

        // Bot is only actually installed in one of the two guilds the user belongs to.
        mockedGetDiscordClient.mockReturnValue({
            guilds: { cache: new Map([[MEMBER_GUILD_WITH_BOT.id, {}]]) },
        });
    });

    describe('PKCE', () => {
        it('code_challenge is the base64url(SHA-256(code_verifier)) of the generated verifier', () => {
            const service = new DiscordOAuthService();
            const { verifier, challenge } = service.generatePkce();
            const expected = createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            expect(challenge).toBe(expected);
        });
    });

    describe('GET /api/v1/auth/discord', () => {
        it('redirects to Discord with client_id, PKCE challenge and a state cookie', async () => {
            const response = await fastify.inject({ method: 'GET', url: '/api/v1/auth/discord' });

            expect(response.statusCode).toBe(302);
            const location = new URL(response.headers.location as string);
            expect(location.origin + location.pathname).toBe('https://discord.com/oauth2/authorize');
            expect(location.searchParams.get('client_id')).toBe('test-client-id');
            expect(location.searchParams.get('code_challenge_method')).toBe('S256');
            expect(location.searchParams.get('state')).toBeTruthy();

            const stateCookie = extractCookie(response.headers['set-cookie'], 'lp_oauth_state');
            expect(stateCookie).toBe(location.searchParams.get('state'));
        });
    });

    describe('full login -> /me -> /me/guilds -> logout flow', () => {
        it('walks the whole session lifecycle', async () => {
            // 1. Start login
            const start = await fastify.inject({ method: 'GET', url: '/api/v1/auth/discord' });
            const location = new URL(start.headers.location as string);
            const state = location.searchParams.get('state')!;
            const oauthStateCookie = extractCookie(start.headers['set-cookie'], 'lp_oauth_state')!;

            // 2. Discord redirects back with ?code&state
            const callback = await fastify.inject({
                method: 'GET',
                url: `/api/v1/auth/discord/callback?code=fake-code&state=${state}`,
                headers: { cookie: `lp_oauth_state=${oauthStateCookie}` },
            });

            expect(callback.statusCode).toBe(302);
            expect(callback.headers.location).toBe('/app/');
            const sessionCookie = extractCookie(callback.headers['set-cookie'], 'lp_session');
            expect(sessionCookie).toBeTruthy();

            // 3. GET /api/v1/me
            const me = await fastify.inject({
                method: 'GET',
                url: '/api/v1/me',
                headers: { cookie: `lp_session=${sessionCookie}` },
            });
            expect(me.statusCode).toBe(200);
            expect(JSON.parse(me.payload)).toEqual({
                id: FAKE_USER.id,
                username: FAKE_USER.username,
                globalName: FAKE_USER.global_name,
                avatar: FAKE_USER.avatar,
            });

            // 4. GET /api/v1/me/guilds — only the guild where the bot is installed
            const guilds = await fastify.inject({
                method: 'GET',
                url: '/api/v1/me/guilds',
                headers: { cookie: `lp_session=${sessionCookie}` },
            });
            expect(guilds.statusCode).toBe(200);
            const guildsBody = JSON.parse(guilds.payload);
            expect(guildsBody).toHaveLength(1);
            expect(guildsBody[0]).toEqual({
                id: MEMBER_GUILD_WITH_BOT.id,
                name: MEMBER_GUILD_WITH_BOT.name,
                icon: null,
                canManage: true,
            });

            // 5. Logout destroys the session
            const logout = await fastify.inject({
                method: 'POST',
                url: '/api/v1/auth/logout',
                headers: { cookie: `lp_session=${sessionCookie}` },
            });
            expect(logout.statusCode).toBe(200);
            expect(mockedAxios.post).toHaveBeenCalledWith(
                expect.stringContaining('/oauth2/token/revoke'),
                expect.anything(),
                expect.anything(),
            );

            // 6. The old session cookie no longer works
            const afterLogout = await fastify.inject({
                method: 'GET',
                url: '/api/v1/me',
                headers: { cookie: `lp_session=${sessionCookie}` },
            });
            expect(afterLogout.statusCode).toBe(401);
        });

        it('rejects a callback whose state does not match the oauth_state cookie (CSRF)', async () => {
            const start = await fastify.inject({ method: 'GET', url: '/api/v1/auth/discord' });
            const oauthStateCookie = extractCookie(start.headers['set-cookie'], 'lp_oauth_state')!;

            const callback = await fastify.inject({
                method: 'GET',
                url: `/api/v1/auth/discord/callback?code=fake-code&state=attacker-supplied-state`,
                headers: { cookie: `lp_oauth_state=${oauthStateCookie}` },
            });

            expect(callback.statusCode).toBe(302);
            expect(callback.headers.location).toBe('/app/?login=error');
        });

        it('rejects a reused state (single-use PKCE attempt)', async () => {
            const start = await fastify.inject({ method: 'GET', url: '/api/v1/auth/discord' });
            const location = new URL(start.headers.location as string);
            const state = location.searchParams.get('state')!;
            const oauthStateCookie = extractCookie(start.headers['set-cookie'], 'lp_oauth_state')!;
            const cookieHeader = { cookie: `lp_oauth_state=${oauthStateCookie}` };
            const url = `/api/v1/auth/discord/callback?code=fake-code&state=${state}`;

            const first = await fastify.inject({ method: 'GET', url, headers: cookieHeader });
            expect(first.statusCode).toBe(302);
            expect(first.headers.location).toBe('/app/');

            const second = await fastify.inject({ method: 'GET', url, headers: cookieHeader });
            expect(second.headers.location).toBe('/app/?login=error');
        });
    });

    describe('guarded routes without a session', () => {
        it('GET /api/v1/me returns 401', async () => {
            const response = await fastify.inject({ method: 'GET', url: '/api/v1/me' });
            expect(response.statusCode).toBe(401);
        });

        it('GET /api/v1/me/guilds returns 401', async () => {
            const response = await fastify.inject({ method: 'GET', url: '/api/v1/me/guilds' });
            expect(response.statusCode).toBe(401);
        });

        it('POST /api/v1/auth/logout returns 401', async () => {
            const response = await fastify.inject({ method: 'POST', url: '/api/v1/auth/logout' });
            expect(response.statusCode).toBe(401);
        });
    });

    /**
     * The legal gate, enforced by the server.
     *
     * It used to live only in `LegalGate.tsx`, so anyone calling the API
     * directly walked past it: `needsLegalAcceptance()` was exported and called
     * from nowhere. These tests pin both halves of the rule — the archive is
     * closed until the documents are accepted, identity stays open so the
     * acceptance screen can work at all.
     */
    describe('legal gate', () => {
        async function loggedInCookie(): Promise<string> {
            const start = await fastify.inject({ method: 'GET', url: '/api/v1/auth/discord' });
            const location = new URL(start.headers.location as string);
            const state = location.searchParams.get('state')!;
            const oauthStateCookie = extractCookie(start.headers['set-cookie'], 'lp_oauth_state')!;
            const callback = await fastify.inject({
                method: 'GET',
                url: `/api/v1/auth/discord/callback?code=fake-code&state=${state}`,
                headers: { cookie: `lp_oauth_state=${oauthStateCookie}` },
            });
            return extractCookie(callback.headers['set-cookie'], 'lp_session')!;
        }

        it('refuses campaign data until the documents are accepted', async () => {
            const sessionCookie = await loggedInCookie();

            const response = await fastify.inject({
                method: 'GET',
                url: `/api/v1/guilds/${MEMBER_GUILD_WITH_BOT.id}/campaigns`,
                headers: { cookie: `lp_session=${sessionCookie}` },
            });

            expect(response.statusCode).toBe(403);
        });

        it('still lets identity and logout through', async () => {
            const sessionCookie = await loggedInCookie();
            const header = { cookie: `lp_session=${sessionCookie}` };

            // Gating these would lock the user out of the screen that unlocks
            // everything else.
            expect((await fastify.inject({ method: 'GET', url: '/api/v1/me', headers: header })).statusCode).toBe(200);
            expect((await fastify.inject({ method: 'GET', url: '/api/v1/me/legal', headers: header })).statusCode).toBe(200);
            expect((await fastify.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: header })).statusCode).toBe(200);
        });
    });
});
