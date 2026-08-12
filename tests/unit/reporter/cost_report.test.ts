import type { SessionMetrics } from '../../../src/monitor';
import { renderCostAnalysisRows } from '../../../src/reporter/costReport';

function metricsWithCosts(): SessionMetrics {
    return {
        sessionId: 'cost-report-test',
        startTime: 1,
        totalFiles: 0,
        totalAudioDurationSec: 0,
        transcriptionTimeMs: 0,
        summarizationTimeMs: 0,
        totalTokensUsed: 0,
        errors: [],
        resourceUsage: { cpuSamples: [], ramSamplesMB: [] },
        costMetrics: {
            totalCostUSD: 0.011,
            totalCostEUR: 0.01,
            usdPerEur: 1.1,
            exchangeRateSource: 'ECB',
            exchangeRateDate: '2026-07-27',
            exchangeRateFetchedAt: 1_775_000_000_000,
            byProvider: {
                openai: 0.011,
                gemini: 0,
                ollama: 0,
                'ollama-cloud': 0,
                anthropic: 0,
            },
            breakdown: [{
                phase: 'analyst',
                provider: 'openai',
                model: 'gpt-5.4-mini',
                inputTokens: 1_000,
                outputTokens: 100,
                costUSD: 0.011,
                costEUR: 0.01,
            }],
        },
    };
}

describe('reporter EUR cost section', () => {
    it('shows EUR as primary amount, USD as reference and the frozen ECB rate', () => {
        const html = renderCostAnalysisRows(metricsWithCosts());

        expect(html).toContain('€0.0100 EUR');
        expect(html).toContain('$0.0110 USD');
        expect(html).toContain('1 EUR = 1.1000 USD');
        expect(html).toContain('2026-07-27');
        expect(html).toContain('Data Analyst (Extraction)');
    });

    it('does not invent an EUR amount when conversion is unavailable', () => {
        const metrics = metricsWithCosts();
        metrics.costMetrics!.totalCostEUR = null;
        metrics.costMetrics!.usdPerEur = null;
        metrics.costMetrics!.exchangeRateSource = 'UNAVAILABLE';
        metrics.costMetrics!.exchangeRateDate = null;
        metrics.costMetrics!.breakdown[0].costEUR = null;

        const html = renderCostAnalysisRows(metrics);
        expect(html).toContain('Conversione EUR non disponibile');
        expect(html).toContain('$0.0110 USD');
        expect(html).not.toContain('€0.0100 EUR');
    });
});
