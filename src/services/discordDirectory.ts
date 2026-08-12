/**
 * Readable names for Discord ids.
 *
 * The database stores who sits at a table as a snowflake and nothing else: the
 * bot always had a `GuildMember` at hand and never needed to write the name
 * down. The web has no such luxury — a members list printing
 * `310865403066712074` tells nobody who that is.
 *
 * The names are asked of Discord and never persisted: they are the user's data,
 * they change (nickname, global name), and a stale copy in our database would be
 * both wrong and one more thing to erase on request.
 */

import { getDiscordClient } from '../discordClient';
import { logger } from '../utils/logger';

const log = logger('DiscordDirectory');

export interface DiscordDisplayName {
    /** Guild nickname, else the global name, else the username. Null when Discord cannot be reached. */
    displayName: string | null;
    /** The @handle, when known. */
    username: string | null;
}

/**
 * Short-lived cache: a members list is re-fetched on every visit to the
 * settings page, and each miss is a REST round trip to Discord.
 */
const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { value: DiscordDisplayName; expiresAt: number }>();

/** Exposed for the tests: there is no other way to observe a cache. */
export function clearDiscordDirectoryCache(): void {
    cache.clear();
}

async function resolveOne(guildId: string, userId: string): Promise<DiscordDisplayName> {
    const client = getDiscordClient();
    // No Discord connection (standalone web preview, or the process is still
    // booting): the caller falls back to the character name.
    if (!client) return { displayName: null, username: null };

    const guild = client.guilds.cache.get(guildId);
    if (guild) {
        const cached = guild.members.cache.get(userId);
        const member = cached ?? await guild.members.fetch(userId).catch(() => null);
        if (member) {
            return {
                displayName: member.nickname ?? member.user.globalName ?? member.user.username,
                username: member.user.username,
            };
        }
    }

    // Left the server, or the bot cannot see them: the account may still exist.
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return { displayName: null, username: null };
    return { displayName: user.globalName ?? user.username, username: user.username };
}

/**
 * Resolves several ids at once, best effort: an id Discord will not answer for
 * comes back with null names rather than failing the whole list.
 */
export async function resolveGuildDisplayNames(
    guildId: string,
    userIds: readonly string[],
): Promise<Map<string, DiscordDisplayName>> {
    const now = Date.now();
    const result = new Map<string, DiscordDisplayName>();
    const missing: string[] = [];

    for (const userId of new Set(userIds)) {
        const hit = cache.get(`${guildId}:${userId}`);
        if (hit && hit.expiresAt > now) result.set(userId, hit.value);
        else missing.push(userId);
    }

    const resolved = await Promise.all(missing.map(async (userId) => {
        try {
            return [userId, await resolveOne(guildId, userId)] as const;
        } catch (error) {
            log.warn(`Could not resolve ${userId} on guild ${guildId}: ${String(error)}`);
            return [userId, { displayName: null, username: null }] as const;
        }
    }));

    for (const [userId, value] of resolved) {
        cache.set(`${guildId}:${userId}`, { value, expiresAt: now + TTL_MS });
        result.set(userId, value);
    }

    return result;
}
