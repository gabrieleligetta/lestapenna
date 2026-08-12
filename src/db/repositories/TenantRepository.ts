import { db } from '../client';
import { Tenant, UsageTracking } from '../types';

/**
 * Per-guild record + usage telemetry.
 *
 * There are no plans, quotas or limits any more: Lestapenna is free and every
 * table uses its own AI keys (BYOK). `usage_tracking` stays because it feeds
 * cost transparency — how much the user has spent on *their own* provider
 * account — not billing.
 */

function getCurrentMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export const tenantRepository = {

    // =============================================
    // GUILD RECORD
    // =============================================

    getTenant: (guildId: string): Tenant | undefined => {
        return db.prepare('SELECT * FROM tenants WHERE guild_id = ?').get(guildId) as Tenant | undefined;
    },

    /** Returns the guild's row, or a virtual one for guilds not yet registered. */
    getOrDefaultTenant: (guildId: string): Tenant => {
        const existing = db.prepare('SELECT * FROM tenants WHERE guild_id = ?').get(guildId) as Tenant | undefined;
        if (existing) return existing;

        return {
            guild_id: guildId,
            created_at: Date.now(),
            admin_discord_id: null,
        };
    },

    createTenant: (guildId: string, adminDiscordId?: string): void => {
        db.prepare(`
            INSERT INTO tenants (guild_id, created_at, admin_discord_id)
            VALUES (?, ?, ?)
        `).run(guildId, Date.now(), adminDiscordId ?? null);
    },

    upsertTenant: (guildId: string, adminDiscordId?: string): void => {
        db.prepare(`
            INSERT INTO tenants (guild_id, created_at, admin_discord_id)
            VALUES (?, ?, ?)
            ON CONFLICT(guild_id) DO UPDATE SET
                admin_discord_id = COALESCE(excluded.admin_discord_id, tenants.admin_discord_id)
        `).run(guildId, Date.now(), adminDiscordId ?? null);
    },

    listTenants: (): Tenant[] => {
        return db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all() as Tenant[];
    },

    // =============================================
    // USAGE TRACKING
    // =============================================

    /**
     * Returns current month's usage for a guild, creating the row if needed.
     */
    getUsage: (guildId: string, month?: string): UsageTracking => {
        const m = month ?? getCurrentMonth();
        const existing = db.prepare('SELECT * FROM usage_tracking WHERE guild_id = ? AND month = ?').get(guildId, m) as UsageTracking | undefined;
        if (existing) return existing;

        // Auto-create row for current month
        db.prepare(`
            INSERT OR IGNORE INTO usage_tracking (guild_id, month) VALUES (?, ?)
        `).run(guildId, m);

        return db.prepare('SELECT * FROM usage_tracking WHERE guild_id = ? AND month = ?').get(guildId, m) as UsageTracking;
    },

    /** Returns lifetime totals across every month tracked for a guild. */
    getLifetimeUsage: (guildId: string): { sessions_used: number; audio_minutes_used: number } => {
        return db.prepare(`
            SELECT COALESCE(SUM(sessions_used), 0) AS sessions_used,
                   COALESCE(SUM(audio_minutes_used), 0) AS audio_minutes_used
            FROM usage_tracking WHERE guild_id = ?
        `).get(guildId) as { sessions_used: number; audio_minutes_used: number };
    },

    incrementSessions: (guildId: string, count: number = 1): void => {
        const month = getCurrentMonth();
        db.prepare(`
            INSERT INTO usage_tracking (guild_id, month, sessions_used)
            VALUES (?, ?, ?)
            ON CONFLICT(guild_id, month) DO UPDATE SET sessions_used = sessions_used + ?
        `).run(guildId, month, count, count);
    },

    addAudioMinutes: (guildId: string, minutes: number): void => {
        const month = getCurrentMonth();
        db.prepare(`
            INSERT INTO usage_tracking (guild_id, month, audio_minutes_used)
            VALUES (?, ?, ?)
            ON CONFLICT(guild_id, month) DO UPDATE SET audio_minutes_used = audio_minutes_used + ?
        `).run(guildId, month, minutes, minutes);
    },

    addAiCost: (guildId: string, costUsd: number, costEur: number | null = null): void => {
        const month = getCurrentMonth();
        db.prepare(`
            INSERT INTO usage_tracking (guild_id, month, ai_cost_usd, ai_cost_eur)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(guild_id, month) DO UPDATE SET
                ai_cost_usd = usage_tracking.ai_cost_usd + excluded.ai_cost_usd,
                ai_cost_eur = CASE
                    WHEN excluded.ai_cost_eur IS NULL THEN NULL
                    WHEN usage_tracking.ai_cost_usd = 0
                        AND usage_tracking.ai_cost_eur IS NULL
                        THEN excluded.ai_cost_eur
                    WHEN usage_tracking.ai_cost_eur IS NULL THEN NULL
                    ELSE usage_tracking.ai_cost_eur + excluded.ai_cost_eur
                END
        `).run(guildId, month, costUsd, costEur);
    },

    addStorageBytes: (guildId: string, bytes: number): void => {
        const month = getCurrentMonth();
        db.prepare(`
            INSERT INTO usage_tracking (guild_id, month, storage_bytes)
            VALUES (?, ?, ?)
            ON CONFLICT(guild_id, month) DO UPDATE SET storage_bytes = storage_bytes + ?
        `).run(guildId, month, bytes, bytes);
    },

    /** Returns usage history for the last N months. */
    getUsageHistory: (guildId: string, months: number = 6): UsageTracking[] => {
        return db.prepare(`
            SELECT * FROM usage_tracking
            WHERE guild_id = ?
            ORDER BY month DESC
            LIMIT ?
        `).all(guildId, months) as UsageTracking[];
    },
};
