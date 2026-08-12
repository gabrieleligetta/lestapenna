import { calculateCost, resolvePricing } from '../../../src/monitor/costs';

describe('monitor/costs', () => {
    describe('resolvePricing', () => {
        it('matches an exact model name', () => {
            const pricing = resolvePricing('claude-sonnet-5');
            expect(pricing).toEqual({ input: 3.00, output: 15.00, cachedInput: 0.30 });
        });

        it('falls back to a prefix match for unlisted model variants', () => {
            const pricing = resolvePricing('gpt-5.4-mini-2026-05-01');
            expect(pricing).toEqual({ input: 0.75, output: 4.50, cachedInput: 0.075 });
        });

        it('returns null for a completely unknown model', () => {
            expect(resolvePricing('totally-made-up-model')).toBeNull();
        });

        it('picks the more specific prefix over a shorter generic one', () => {
            // 'gpt-5' is a prefix of 'gpt-5.4', so key ordering in OPENAI_PRICING matters.
            const pricing = resolvePricing('gpt-5.4-some-future-suffix');
            expect(pricing).toEqual({ input: 2.50, output: 15.00, cachedInput: 0.25 });
        });
    });

    describe('calculateCost', () => {
        it('computes cost from input/output/cached tokens using the resolved rates', () => {
            const pricing = resolvePricing('claude-sonnet-5')!;
            const cost = calculateCost('claude-sonnet-5', 1_000_000, 1_000_000, 500_000);
            const expected = pricing.input + pricing.output + 0.5 * pricing.cachedInput;
            expect(cost).toBeCloseTo(expected, 6);
        });

        it('returns 0 and warns for an unknown model', () => {
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            expect(calculateCost('totally-made-up-model', 1000, 1000)).toBe(0);
            expect(warnSpy).toHaveBeenCalled();
            warnSpy.mockRestore();
        });

        it('defaults cachedInputTokens to 0 when omitted', () => {
            const pricing = resolvePricing('gpt-4o-mini')!;
            const cost = calculateCost('gpt-4o-mini', 1_000_000, 1_000_000);
            expect(cost).toBeCloseTo(pricing.input + pricing.output, 6);
        });
    });
});
