import { db } from '../client';
import { AiUsageLogEntry } from '../types';

/** One AI usage row to persist, exactly as tracked by Monitor.costMetrics.breakdown. */
export interface AiUsageLogInput {
    phase: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    inputPricePerMillion?: number;
    outputPricePerMillion?: number;
    cachedInputPricePerMillion?: number;
    costUSD: number;
    costEUR?: number | null;
    /** ECB quote: USD for one EUR. */
    usdPerEur?: number | null;
    exchangeRateSource?: 'ECB' | 'STALE_ECB' | 'UNAVAILABLE' | null;
    exchangeRateDate?: string | null;
    exchangeRateFetchedAt?: number | null;
    /**
     * Where the rate came from. Without it, spend at an unknown price is
     * indistinguishable from free — both end up as zero.
     */
    pricingSource?: import('../../services/pricingSource').PricingSource | null;
}

export interface PhaseCostBreakdown {
    phase: string;
    cost_usd: number;
    cost_eur: number | null;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    requests: number;
}

export const aiUsageRepository = {
    /**
     * Persists a session's whole breakdown at once (called by Monitor.endSession()).
     * Append-only: no updates, one record per logged AI request.
     */
    logSessionUsage: (sessionId: string, guildId: string | null, campaignId: number | null, entries: AiUsageLogInput[]): void => {
        if (entries.length === 0) return;

        const insertMany = db.transaction((rows: AiUsageLogInput[]) => {
            const insert = db.prepare(`
                INSERT INTO ai_usage_log (
                    session_id, guild_id, campaign_id, phase, provider, model,
                    input_tokens, output_tokens, cached_input_tokens,
                    input_price_per_million, output_price_per_million, cached_input_price_per_million,
                    cost_usd, cost_eur, usd_per_eur, exchange_rate_source,
                    exchange_rate_date, exchange_rate_fetched_at, created_at, pricing_source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const now = Date.now();
            for (const r of rows) {
                insert.run(
                    sessionId,
                    guildId,
                    campaignId,
                    r.phase,
                    r.provider,
                    r.model,
                    r.inputTokens,
                    r.outputTokens,
                    r.cachedInputTokens ?? 0,
                    r.inputPricePerMillion ?? null,
                    r.outputPricePerMillion ?? null,
                    r.cachedInputPricePerMillion ?? null,
                    r.costUSD,
                    r.costEUR ?? null,
                    r.usdPerEur ?? null,
                    r.exchangeRateSource ?? null,
                    r.exchangeRateDate ?? null,
                    r.exchangeRateFetchedAt ?? null,
                    now,
                    r.pricingSource ?? null,
                );
            }
        });
        insertMany(entries);
    },

    /** Total cost/tokens for a session (summed across all phases). */
    getSessionTotalCost: (sessionId: string): { cost_usd: number; cost_eur: number | null; input_tokens: number; output_tokens: number } => {
        return db.prepare(`
            SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd,
                   CASE
                       WHEN COUNT(*) = 0 THEN 0
                       WHEN COUNT(cost_eur) = COUNT(*) THEN SUM(cost_eur)
                       ELSE NULL
                   END AS cost_eur,
                   COALESCE(SUM(input_tokens), 0) AS input_tokens,
                   COALESCE(SUM(output_tokens), 0) AS output_tokens
            FROM ai_usage_log WHERE session_id = ?
        `).get(sessionId) as { cost_usd: number; cost_eur: number | null; input_tokens: number; output_tokens: number };
    },

    /** Cost/tokens for a session, broken down by phase (analyst, summary, transcription, etc.). */
    getSessionCostByPhase: (sessionId: string): PhaseCostBreakdown[] => {
        return db.prepare(`
            SELECT phase,
                   SUM(cost_usd) AS cost_usd,
                   CASE
                       WHEN COUNT(cost_eur) = COUNT(*) THEN SUM(cost_eur)
                       ELSE NULL
                   END AS cost_eur,
                   SUM(input_tokens) AS input_tokens,
                   SUM(output_tokens) AS output_tokens,
                   SUM(cached_input_tokens) AS cached_input_tokens,
                   COUNT(*) AS requests
            FROM ai_usage_log WHERE session_id = ?
            GROUP BY phase ORDER BY cost_usd DESC
        `).all(sessionId) as PhaseCostBreakdown[];
    },

    /** AI cost history for a guild, aggregated by month: what the table spent
     * on its own keys, shown back to it. There are no quotas and no margins. */
    getGuildCostHistory: (guildId: string, months: number = 6): Array<{ month: string; cost_usd: number; cost_eur: number | null; sessions: number }> => {
        return db.prepare(`
            SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch') AS month,
                   SUM(cost_usd) AS cost_usd,
                   CASE
                       WHEN COUNT(cost_eur) = COUNT(*) THEN SUM(cost_eur)
                       ELSE NULL
                   END AS cost_eur,
                   COUNT(DISTINCT session_id) AS sessions
            FROM ai_usage_log WHERE guild_id = ?
            GROUP BY month ORDER BY month DESC LIMIT ?
        `).all(guildId, months) as Array<{ month: string; cost_usd: number; cost_eur: number | null; sessions: number }>;
    },

    /**
     * What one run of an on-demand action cost, read back by its run id.
     *
     * It is how a job row shows a price without storing one: the ledger stays
     * the single source, and the job carries only the id that points at it.
     *
     * `null` where the others return `0`, and that is the whole point. A run
     * with no rows is a call whose model has no published price — nothing was
     * written precisely because we did not know — and rendering that as «free»
     * would be a lie about the most expensive action in the product.
     */
    getRunCost: (runId: string): { costUsd: number | null; costEur: number | null; rows: number } => {
        const row = db.prepare(`
            SELECT COUNT(*) AS rows,
                   SUM(cost_usd) AS cost_usd,
                   CASE
                       WHEN COUNT(cost_eur) = COUNT(*) THEN SUM(cost_eur)
                       ELSE NULL
                   END AS cost_eur
            FROM ai_usage_log WHERE session_id = ?
        `).get(runId) as { rows: number; cost_usd: number | null; cost_eur: number | null };

        if (!row || row.rows === 0) return { costUsd: null, costEur: null, rows: 0 };
        return { costUsd: row.cost_usd, costEur: row.cost_eur, rows: row.rows };
    },

    /** Raw rows of a session (full drill-down, e.g. for debugging/auditing). */
    getSessionEntries: (sessionId: string): AiUsageLogEntry[] => {
        return db.prepare(`SELECT * FROM ai_usage_log WHERE session_id = ? ORDER BY created_at ASC`).all(sessionId) as AiUsageLogEntry[];
    },
};
