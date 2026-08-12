import * as crypto from 'crypto';

/**
 * Cache of the SDK clients, keyed on the credentials without containing them.
 *
 * Building an OpenAI/Anthropic client for every call would waste the HTTP
 * connection pool; keeping a single one per process — as it used to be — is
 * incompatible with BYOK, because every table has different keys.
 *
 * The cache key is a hash that includes the credential's **fingerprint**, never
 * its value: two tables with the same key share the client, and a rotated key
 * produces a different entry.
 */

interface Entry<T> {
    value: T;
    expiresAt: number;
    /** To invalidate every entry of a guild when its configuration changes. */
    scopeId: string;
}

const MAX_ENTRIES = 64;
const TTL_MS = 15 * 60 * 1000;

const pool = new Map<string, Entry<unknown>>();

export function poolCacheKey(parts: Array<string | number | undefined | null>): string {
    return crypto.createHash('sha256').update(parts.map(p => String(p ?? '')).join('|')).digest('hex');
}

export function getPooled<T>(cacheKey: string, scopeId: string, factory: () => T): T {
    const now = Date.now();
    const hit = pool.get(cacheKey);
    if (hit && hit.expiresAt > now) {
        // Rinfresca la posizione LRU.
        pool.delete(cacheKey);
        pool.set(cacheKey, hit);
        return hit.value as T;
    }

    const value = factory();
    pool.set(cacheKey, { value, expiresAt: now + TTL_MS, scopeId });

    if (pool.size > MAX_ENTRIES) {
        const oldest = pool.keys().next().value;
        if (oldest !== undefined) pool.delete(oldest);
    }
    return value;
}

/**
 * Throws away a guild's clients.
 *
 * To be called when the table saves new settings or rotates a key: without it
 * the old credential would stay in use until the TTL expires, and the user would
 * see the UI say one thing and the system do another.
 */
export function invalidateScope(scopeId: string): void {
    for (const [key, entry] of pool) {
        if (entry.scopeId === scopeId) pool.delete(key);
    }
}

/** Tests only: clears the state shared between cases. */
export function clearPool(): void {
    pool.clear();
}
