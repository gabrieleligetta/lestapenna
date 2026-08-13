import { db } from '../../db/client';
import { runWithAiScope } from './ambientScope';
import type { AiScope } from './types';

/**
 * Where the guild that pays comes from.
 *
 * Almost everywhere, the pipeline knows a campaign or a session, not a guild:
 * the worker receives a `sessionId`, reconciliation a `campaignId`, the Discord
 * command a `message.guild.id`. This is where that is translated, with two
 * direct queries rather than through the `../../db` barrel — which would import
 * half the project into the AI layer and create a cycle.
 *
 * `campaigns.guild_id` is `NOT NULL`, so the campaign is a reliable source.
 * `sessions.guild_id` however is nullable — sessions predating multi-guild do
 * not have it — so we fall back to the session's campaign.
 */

const guildByCampaign = new Map<number, string>();
const guildBySession = new Map<string, string>();
const campaignBySession = new Map<string, number>();

/** The guild that owns a campaign, or `undefined` when the campaign does not exist. */
export function guildIdForCampaign(campaignId: number): string | undefined {
    const cached = guildByCampaign.get(campaignId);
    if (cached) return cached;

    const row = db.prepare('SELECT guild_id FROM campaigns WHERE id = ?')
        .get(campaignId) as { guild_id: string } | undefined;
    if (row?.guild_id) guildByCampaign.set(campaignId, row.guild_id);
    return row?.guild_id;
}

/** A session's guild: its own, or that of the campaign it belongs to. */
export function guildIdForSession(sessionId: string): string | undefined {
    const cached = guildBySession.get(sessionId);
    if (cached) return cached;

    const row = db.prepare('SELECT guild_id, campaign_id FROM sessions WHERE session_id = ?')
        .get(sessionId) as { guild_id: string | null; campaign_id: number | null } | undefined;
    if (!row) return undefined;

    const guildId = row.guild_id ?? (row.campaign_id ? guildIdForCampaign(row.campaign_id) : undefined);
    if (guildId) guildBySession.set(sessionId, guildId);
    if (row.campaign_id) campaignBySession.set(sessionId, row.campaign_id);
    return guildId;
}

/** The campaign a session belongs to, when it has one. */
export function campaignIdForSession(sessionId: string): number | undefined {
    if (campaignBySession.has(sessionId)) return campaignBySession.get(sessionId);

    // Populates both caches: the two answers come from the same row.
    guildIdForSession(sessionId);
    return campaignBySession.get(sessionId);
}

/**
 * A campaign's scope.
 *
 * Throws when the campaign does not lead to a guild. There is no fallback scope
 * to charge the spend to: `campaigns.guild_id` is `NOT NULL`, so getting here
 * without a guild means a non-existent campaign, that is, a caller error — not a
 * call to be executed anyway at somebody else's expense.
 *
 * `campaignId` stays in the scope even though today resolution only looks at the
 * guild: it is what will let the advanced settings' per-campaign overrides be
 * one more piece of data rather than a refactor.
 */
export function scopeForCampaign(campaignId: number): AiScope {
    const guildId = guildIdForCampaign(campaignId);
    if (!guildId) {
        throw new Error(`Nessuna gilda per la campagna ${campaignId}: non si sa chi paga.`);
    }
    return { guildId, campaignId };
}

/**
 * Scope of a recorded session.
 *
 * The campaign travels alongside the guild, and it has to: the guild is who
 * pays, but the campaign is what carries the per-campaign model overrides. A
 * scope without it would make those overrides invisible to the very pipeline
 * they are meant to configure — saved in the settings, ignored at recording
 * time, which is worse than not offering them.
 */
export function scopeForSession(sessionId: string): AiScope | undefined {
    const guildId = guildIdForSession(sessionId);
    if (!guildId) return undefined;
    const campaignId = campaignIdForSession(sessionId);
    return campaignId ? { guildId, campaignId, sessionId } : { guildId, sessionId };
}

/**
 * Runs a session's work in its table's scope.
 *
 * It is the re-entry into the store after the Redis boundary: a BullMQ job
 * restarts in a different async context, where the caller's `AsyncLocalStorage`
 * no longer exists. The guild is re-read from the database and not from the
 * payload — so a job already queued at deploy time still resolves, and a table
 * cannot change it by writing to Redis.
 *
 * If the session leads to no guild we do not enter the store: `requireAiScope()`
 * decides, and on a public instance it throws rather than charging the operator.
 */
export function runWithSessionScope<T>(sessionId: string, fn: () => T): T {
    const scope = scopeForSession(sessionId);
    return scope ? runWithAiScope(scope, fn) : fn();
}

/**
 * To be cleared when a campaign changes guild or is deleted — and in the tests,
 * which recreate the database between cases while reusing the same ids.
 */
export function clearScopeCache(): void {
    guildByCampaign.clear();
    guildBySession.clear();
    campaignBySession.clear();
}
