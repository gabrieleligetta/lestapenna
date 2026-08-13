/**
 * Redis-backed storage for the web login flow:
 *   - short-lived PKCE verifier, stashed between GET /auth/discord and the
 *     Discord callback (keyed by the CSRF `state` value itself)
 *   - the actual web session created after a successful login
 *
 * Separate Redis connection from src/state/sessionState.ts on purpose: that
 * module tracks Discord *recording* sessions (a completely different concept
 * that happens to share the English word "session"), not web logins.
 */

import Redis from 'ioredis';
import { config } from '../../config';
import { DiscordGuildSummary } from './discordOAuth.service';

const redis = process.env.DISABLE_REDIS === 'true' ? null : new Redis({
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: null,
    lazyConnect: true,
});
redis?.connect().catch(() => {
    // Reconnects automatically; callers see failures per-command, not here.
});

interface MemoryEntry {
    value: string;
    expiresAt: number;
}

// Used only by tests/local harnesses that explicitly disable Redis. Production
// remains Redis-backed so OAuth attempts and logins survive process restarts.
const memoryStore = new Map<string, MemoryEntry>();

function memoryGet(key: string): string | null {
    const entry = memoryStore.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        memoryStore.delete(key);
        return null;
    }
    return entry.value;
}

async function getValue(key: string): Promise<string | null> {
    return redis ? redis.get(key) : memoryGet(key);
}

async function setValue(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (redis) {
        await redis.set(key, value, 'EX', ttlSeconds);
        return;
    }
    memoryStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

async function deleteValue(key: string): Promise<void> {
    if (redis) await redis.del(key);
    else memoryStore.delete(key);
}

async function ttlSeconds(key: string): Promise<number> {
    if (redis) return redis.ttl(key);
    const entry = memoryStore.get(key);
    if (!entry || memoryGet(key) === null) return -2;
    return Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000));
}

const OAUTH_ATTEMPT_PREFIX = 'lp:oauth-attempt:';
const OAUTH_ATTEMPT_TTL_SECONDS = 600; // 10 minutes to complete the Discord redirect round-trip

const WEB_SESSION_PREFIX = 'lp:websession:';

export interface OAuthAttempt {
    codeVerifier: string;
}

export interface WebSessionData {
    discordUserId: string;
    username: string;
    globalName: string | null;
    avatar: string | null;
    accessToken: string;
    refreshToken: string;
    /** Unix ms — Discord access token expiry, used to decide when to refresh */
    tokenExpiresAt: number;
    /** Cached guild list (with canManage), refreshed lazily by the guild guard */
    guilds: DiscordGuildSummary[];
    guildsFetchedAt: number;
}

export async function storeOAuthAttempt(state: string, attempt: OAuthAttempt): Promise<void> {
    await setValue(`${OAUTH_ATTEMPT_PREFIX}${state}`, JSON.stringify(attempt), OAUTH_ATTEMPT_TTL_SECONDS);
}

/** Deletes the attempt on read (single use) — a second callback with the same state must fail. */
export async function consumeOAuthAttempt(state: string): Promise<OAuthAttempt | null> {
    const key = `${OAUTH_ATTEMPT_PREFIX}${state}`;
    const raw = await getValue(key);
    if (!raw) return null;
    await deleteValue(key);
    return JSON.parse(raw) as OAuthAttempt;
}

export async function createWebSession(sessionId: string, data: WebSessionData): Promise<void> {
    await setValue(
        `${WEB_SESSION_PREFIX}${sessionId}`,
        JSON.stringify(data),
        config.discordOAuth.sessionTtlSeconds,
    );
}

export async function getWebSession(sessionId: string): Promise<WebSessionData | null> {
    const raw = await getValue(`${WEB_SESSION_PREFIX}${sessionId}`);
    return raw ? (JSON.parse(raw) as WebSessionData) : null;
}

/** Overwrites the stored session (e.g. after a token refresh or a guilds re-fetch) without resetting its TTL countdown. */
export async function updateWebSession(sessionId: string, data: WebSessionData): Promise<void> {
    const key = `${WEB_SESSION_PREFIX}${sessionId}`;
    const ttl = await ttlSeconds(key);
    await setValue(key, JSON.stringify(data), ttl > 0 ? ttl : config.discordOAuth.sessionTtlSeconds);
}

export async function destroyWebSession(sessionId: string): Promise<void> {
    await deleteValue(`${WEB_SESSION_PREFIX}${sessionId}`);
}
