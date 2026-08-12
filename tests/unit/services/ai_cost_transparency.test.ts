import {
    calculateActualAiCost,
    estimateAgentCost,
    getUsdEurRate,
    resetUsdEurRateCache,
    usdToEur,
} from '../../../src/services/aiCostTransparency';

describe('AI cost transparency', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        resetUsdEurRateCache();
    });

    afterEach(() => {
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    it('estimates a bounded paid agent locally from prompt size and model pricing', () => {
        const estimate = estimateAgentCost({
            provider: 'gemini',
            model: 'gemini-3.1-pro-preview',
            systemPromptChars: 400,
            userPromptChars: 40_000,
            toolSchemaChars: 2_000,
            subjectCount: 4,
            maxTurns: 5,
            maxToolCalls: 3,
            maxToolResultChars: 2_500,
        });

        expect(estimate.billable).toBe(true);
        expect(estimate.pricingAvailable).toBe(true);
        expect(estimate.tokens.inputMin).toBeGreaterThan(20_000);
        expect(estimate.tokens.inputMax).toBeGreaterThan(estimate.tokens.inputMin);
        expect(estimate.costUsd!.min).toBeGreaterThan(0);
        expect(estimate.costUsd!.max).toBeGreaterThan(estimate.costUsd!.min);
    });

    it('reports zero provider cost for a local model without hiding token usage', () => {
        const estimate = estimateAgentCost({
            provider: 'ollama',
            model: 'local-model',
            systemPromptChars: 100,
            userPromptChars: 1_000,
            toolSchemaChars: 100,
            subjectCount: 1,
            maxTurns: 5,
            maxToolCalls: 3,
            maxToolResultChars: 2_500,
        });

        expect(estimate.billable).toBe(false);
        expect(estimate.costUsd).toEqual({ min: 0, max: 0 });
        expect(estimate.tokens.inputMax).toBeGreaterThan(0);
    });

    it('uses the ECB EUR-base USD quote and retains a seven-day stale fallback', async () => {
        const now = Date.UTC(2026, 6, 27, 16);
        global.fetch = jest.fn().mockResolvedValueOnce({
            ok: true,
            text: async () => `
                <Envelope><Cube><Cube time='2026-07-27'>
                    <Cube currency='USD' rate='1.1389'/>
                </Cube></Cube></Envelope>
            `,
        }) as unknown as typeof fetch;

        const fresh = await getUsdEurRate(now);
        expect(fresh).toMatchObject({
            source: 'ECB',
            usdPerEur: 1.1389,
            rateDate: '2026-07-27',
        });
        expect(usdToEur(1.1389, fresh)).toBeCloseTo(1);

        global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
        const stale = await getUsdEurRate(now + 25 * 60 * 60 * 1000);
        expect(stale.source).toBe('STALE_ECB');
        expect(stale.usdPerEur).toBe(1.1389);

        const unavailable = await getUsdEurRate(now + 8 * 24 * 60 * 60 * 1000);
        expect(unavailable).toEqual({
            source: 'UNAVAILABLE',
            usdPerEur: null,
            rateDate: null,
            fetchedAt: null,
        });
    });

    it('does not invent a zero price for an unknown paid model', () => {
        const estimate = estimateAgentCost({
            provider: 'anthropic',
            model: 'unknown-paid-model',
            systemPromptChars: 100,
            userPromptChars: 1_000,
            toolSchemaChars: 100,
            subjectCount: 1,
            maxTurns: 5,
            maxToolCalls: 3,
            maxToolResultChars: 2_500,
        });

        expect(estimate.billable).toBe(true);
        expect(estimate.pricingAvailable).toBe(false);
        expect(estimate.costUsd).toBeNull();
    });

    it('prices actual measured usage with the same centralized model tariff', () => {
        const actual = calculateActualAiCost(
            'gemini',
            'gemini-3.1-pro-preview',
            { input: 100_000, output: 2_000, cached: 0 },
        );

        expect(actual).toMatchObject({
            billable: true,
            pricingAvailable: true,
            inputPricePerMillion: 2,
            outputPricePerMillion: 12,
        });
        expect(actual.costUsd).toBeCloseTo(0.224);
    });
});
