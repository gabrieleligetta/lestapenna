import { attachEuroCosts } from '../../../src/monitor/currency';
import type { SessionMetrics } from '../../../src/monitor/types';

function costMetrics(): NonNullable<SessionMetrics['costMetrics']> {
    return {
        totalCostUSD: 0.011,
        breakdown: [
            {
                phase: 'analyst',
                provider: 'openai',
                model: 'gpt-5.4-mini',
                inputTokens: 1_000,
                outputTokens: 100,
                costUSD: 0.011,
            },
            {
                phase: 'embeddings',
                provider: 'ollama',
                model: 'nomic-embed-text',
                inputTokens: 50,
                outputTokens: 0,
                costUSD: 0,
            },
        ],
        byProvider: {
            openai: 0.011,
            gemini: 0,
            ollama: 0,
            'ollama-cloud': 0,
            anthropic: 0,
        },
    };
}

describe('monitor EUR session snapshot', () => {
    it('uses exactly the same ECB snapshot for total and every phase', () => {
        const metrics = costMetrics();
        attachEuroCosts(metrics, {
            source: 'ECB',
            usdPerEur: 1.1,
            rateDate: '2026-07-27',
            fetchedAt: 1_775_000_000_000,
        });

        expect(metrics.totalCostEUR).toBeCloseTo(0.01);
        expect(metrics.breakdown[0].costEUR).toBeCloseTo(0.01);
        expect(metrics.breakdown[1].costEUR).toBe(0);
        expect(metrics.breakdown.every((entry) => entry.usdPerEur === 1.1)).toBe(true);
        expect(metrics.exchangeRateDate).toBe('2026-07-27');
    });

    it('keeps positive EUR costs null if no trustworthy rate exists', () => {
        const metrics = costMetrics();
        attachEuroCosts(metrics, {
            source: 'UNAVAILABLE',
            usdPerEur: null,
            rateDate: null,
            fetchedAt: null,
        });

        expect(metrics.totalCostEUR).toBeNull();
        expect(metrics.breakdown[0].costEUR).toBeNull();
        expect(metrics.breakdown[1].costEUR).toBe(0);
    });
});
