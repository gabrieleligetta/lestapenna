import { db } from '../../../src/db';
import { aiUsageRepository } from '../../../src/db/repositories/AiUsageRepository';

const SESSION_A = 'test_session_ai_usage_a';
const SESSION_B = 'test_session_ai_usage_b';
const GUILD = 'test_guild_ai_usage';

function cleanup() {
    db.prepare('DELETE FROM ai_usage_log WHERE session_id IN (?, ?)').run(SESSION_A, SESSION_B);
}

describe('AiUsageRepository (ai_usage_log)', () => {
    beforeAll(cleanup);
    afterAll(cleanup);

    it('persists a session breakdown across multiple phases', () => {
        aiUsageRepository.logSessionUsage(SESSION_A, GUILD, 42, [
            {
                phase: 'transcription', provider: 'openai', model: 'gpt-4o-mini',
                inputTokens: 1000, outputTokens: 200, cachedInputTokens: 0,
                inputPricePerMillion: 0.15, outputPricePerMillion: 0.60, cachedInputPricePerMillion: 0.075,
                costUSD: 0.00027, costEUR: 0.00027 / 1.1,
                usdPerEur: 1.1, exchangeRateSource: 'ECB',
                exchangeRateDate: '2026-07-27', exchangeRateFetchedAt: 1_775_000_000_000,
            },
            {
                phase: 'summary', provider: 'anthropic', model: 'claude-sonnet-5',
                inputTokens: 5000, outputTokens: 1000, cachedInputTokens: 2000,
                inputPricePerMillion: 3.00, outputPricePerMillion: 15.00, cachedInputPricePerMillion: 0.30,
                costUSD: 0.03060, costEUR: 0.03060 / 1.1,
                usdPerEur: 1.1, exchangeRateSource: 'ECB',
                exchangeRateDate: '2026-07-27', exchangeRateFetchedAt: 1_775_000_000_000,
            },
            {
                phase: 'summary', provider: 'anthropic', model: 'claude-sonnet-5',
                inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0,
                inputPricePerMillion: 3.00, outputPricePerMillion: 15.00, cachedInputPricePerMillion: 0.30,
                costUSD: 0.0105, costEUR: 0.0105 / 1.1,
                usdPerEur: 1.1, exchangeRateSource: 'ECB',
                exchangeRateDate: '2026-07-27', exchangeRateFetchedAt: 1_775_000_000_000,
            },
        ]);

        const entries = aiUsageRepository.getSessionEntries(SESSION_A);
        expect(entries).toHaveLength(3);
        expect(entries[0].guild_id).toBe(GUILD);
        expect(entries[0].campaign_id).toBe(42);
        expect(entries[0].input_price_per_million).toBeCloseTo(0.15);
        expect(entries[0].cost_eur).toBeCloseTo(0.00027 / 1.1);
        expect(entries[0]).toMatchObject({
            usd_per_eur: 1.1,
            exchange_rate_source: 'ECB',
            exchange_rate_date: '2026-07-27',
            exchange_rate_fetched_at: 1_775_000_000_000,
        });
    });

    it('aggregates total cost/tokens for a session', () => {
        const total = aiUsageRepository.getSessionTotalCost(SESSION_A);
        expect(total.cost_usd).toBeCloseTo(0.00027 + 0.03060 + 0.0105, 5);
        expect(total.cost_eur).toBeCloseTo((0.00027 + 0.03060 + 0.0105) / 1.1, 5);
        expect(total.input_tokens).toBe(1000 + 5000 + 1000);
        expect(total.output_tokens).toBe(200 + 1000 + 500);
    });

    it('groups cost/tokens by phase, merging multiple requests in the same phase', () => {
        const byPhase = aiUsageRepository.getSessionCostByPhase(SESSION_A);
        const summary = byPhase.find(p => p.phase === 'summary')!;
        const transcription = byPhase.find(p => p.phase === 'transcription')!;

        expect(summary.requests).toBe(2);
        expect(summary.cost_usd).toBeCloseTo(0.03060 + 0.0105, 5);
        expect(summary.cost_eur).toBeCloseTo((0.03060 + 0.0105) / 1.1, 5);
        expect(summary.input_tokens).toBe(6000);

        expect(transcription.requests).toBe(1);
        expect(transcription.cost_usd).toBeCloseTo(0.00027, 5);
    });

    it('returns zeroed totals for a session with no logged usage', () => {
        const total = aiUsageRepository.getSessionTotalCost('nonexistent_session_xyz');
        expect(total.cost_usd).toBe(0);
        expect(total.cost_eur).toBe(0);
        expect(total.input_tokens).toBe(0);
        expect(total.output_tokens).toBe(0);
    });

    it('is a no-op when logging an empty entry list', () => {
        expect(() => aiUsageRepository.logSessionUsage(SESSION_B, GUILD, null, [])).not.toThrow();
        expect(aiUsageRepository.getSessionEntries(SESSION_B)).toHaveLength(0);
    });

    it('aggregates guild cost history by month across sessions', () => {
        aiUsageRepository.logSessionUsage(SESSION_B, GUILD, null, [
            {
                phase: 'analyst', provider: 'openai', model: 'gpt-4o-mini',
                inputTokens: 100, outputTokens: 50, costUSD: 0.0001,
                costEUR: 0.0001 / 1.1, usdPerEur: 1.1,
                exchangeRateSource: 'ECB', exchangeRateDate: '2026-07-27',
                exchangeRateFetchedAt: 1_775_000_000_000,
            },
        ]);

        const history = aiUsageRepository.getGuildCostHistory(GUILD, 12);
        expect(history.length).toBeGreaterThan(0);
        const currentMonth = history[0];
        expect(currentMonth.sessions).toBe(2); // SESSION_A + SESSION_B
        expect(currentMonth.cost_usd).toBeGreaterThan(0);
        expect(currentMonth.cost_eur).toBeCloseTo(currentMonth.cost_usd / 1.1);
    });

    it('allows null guild_id and campaign_id (guild not resolvable at flush time)', () => {
        const sessionId = 'test_session_ai_usage_null_guild';
        aiUsageRepository.logSessionUsage(sessionId, null, null, [
            { phase: 'embeddings', provider: 'ollama', model: 'nomic-embed-text', inputTokens: 10, outputTokens: 0, costUSD: 0 },
        ]);

        const entries = aiUsageRepository.getSessionEntries(sessionId);
        expect(entries).toHaveLength(1);
        expect(entries[0].guild_id).toBeNull();
        expect(entries[0].campaign_id).toBeNull();

        db.prepare('DELETE FROM ai_usage_log WHERE session_id = ?').run(sessionId);
    });
});
