/**
 * Discord OAuth2 (Authorization Code + PKCE) — talks to discord.com only.
 * No session/cookie concerns here; see webSession.store.ts and auth.controller.ts.
 */

import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { randomBytes, createHash } from 'crypto';
import { config } from '../../config';

const DISCORD_API = 'https://discord.com/api/v10';
const OAUTH_SCOPES = 'identify guilds';

export interface DiscordTokens {
    accessToken: string;
    refreshToken: string;
    /** Unix ms timestamp */
    expiresAt: number;
}

export interface DiscordUser {
    id: string;
    username: string;
    globalName: string | null;
    avatar: string | null;
}

export interface DiscordGuildSummary {
    id: string;
    name: string;
    icon: string | null;
    /** true if the caller has Administrator or Manage Guild on this guild */
    canManage: boolean;
}

const PERMISSION_ADMINISTRATOR = 0x8n;
const PERMISSION_MANAGE_GUILD = 0x20n;

function base64url(input: Buffer): string {
    return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

@Injectable()
export class DiscordOAuthService {
    /** Random, unguessable — used both as CSRF state and as the Redis key for the stashed PKCE verifier. */
    generateState(): string {
        return base64url(randomBytes(24));
    }

    generatePkce(): { verifier: string; challenge: string } {
        const verifier = base64url(randomBytes(32));
        const challenge = base64url(createHash('sha256').update(verifier).digest());
        return { verifier, challenge };
    }

    buildAuthorizeUrl(state: string, codeChallenge: string): string {
        if (!config.discordOAuth.clientId) {
            throw new Error('DISCORD_CLIENT_ID non configurato');
        }
        const params = new URLSearchParams({
            client_id: config.discordOAuth.clientId,
            redirect_uri: config.discordOAuth.redirectUri,
            response_type: 'code',
            scope: OAUTH_SCOPES,
            state,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
        });
        return `https://discord.com/oauth2/authorize?${params.toString()}`;
    }

    private tokensFromResponse(data: {
        access_token: string;
        refresh_token: string;
        expires_in: number;
    }): DiscordTokens {
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresAt: Date.now() + data.expires_in * 1000,
        };
    }

    async exchangeCode(code: string, codeVerifier: string): Promise<DiscordTokens> {
        const response = await axios.post(
            `${DISCORD_API}/oauth2/token`,
            new URLSearchParams({
                client_id: config.discordOAuth.clientId ?? '',
                client_secret: config.discordOAuth.clientSecret ?? '',
                grant_type: 'authorization_code',
                code,
                redirect_uri: config.discordOAuth.redirectUri,
                code_verifier: codeVerifier,
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 },
        );
        return this.tokensFromResponse(response.data);
    }

    async refreshTokens(refreshToken: string): Promise<DiscordTokens> {
        const response = await axios.post(
            `${DISCORD_API}/oauth2/token`,
            new URLSearchParams({
                client_id: config.discordOAuth.clientId ?? '',
                client_secret: config.discordOAuth.clientSecret ?? '',
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 },
        );
        return this.tokensFromResponse(response.data);
    }

    async revokeToken(token: string): Promise<void> {
        try {
            await axios.post(
                `${DISCORD_API}/oauth2/token/revoke`,
                new URLSearchParams({
                    client_id: config.discordOAuth.clientId ?? '',
                    client_secret: config.discordOAuth.clientSecret ?? '',
                    token,
                    token_type_hint: 'refresh_token',
                }).toString(),
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 },
            );
        } catch {
            // Best-effort: the local session is destroyed regardless (see auth.controller logout).
        }
    }

    async fetchUser(accessToken: string): Promise<DiscordUser> {
        const response = await axios.get(`${DISCORD_API}/users/@me`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 10_000,
        });
        const data = response.data;
        return {
            id: data.id,
            username: data.username,
            globalName: data.global_name ?? null,
            avatar: data.avatar ?? null,
        };
    }

    async fetchGuilds(accessToken: string): Promise<DiscordGuildSummary[]> {
        const response = await axios.get(`${DISCORD_API}/users/@me/guilds`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 10_000,
        });
        return (response.data as any[]).map((g) => {
            const permissions = BigInt(g.permissions ?? '0');
            return {
                id: g.id,
                name: g.name,
                icon: g.icon ?? null,
                canManage: (permissions & PERMISSION_ADMINISTRATOR) !== 0n || (permissions & PERMISSION_MANAGE_GUILD) !== 0n,
            };
        });
    }
}
