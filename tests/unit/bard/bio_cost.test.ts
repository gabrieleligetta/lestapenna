import { generateBio } from '../../../src/bard/bio';
import { generateText } from '../../../src/bard/llm/generate';
import {
    buildEuroCostSnapshot,
    calculateActualAiCost,
    getUsdEurRate,
} from '../../../src/services/aiCostTransparency';

jest.mock('../../../src/bard/config', () => ({
    getMetadataClient: jest.fn().mockResolvedValue({
        client: {}, model: 'paid-model', provider: 'openai',
    }),
}));
jest.mock('../../../src/bard/llm/generate', () => ({
    generateText: jest.fn(),
    generateJson: jest.fn(),
}));
jest.mock('../../../src/services/aiCostTransparency', () => ({
    calculateActualAiCost: jest.fn(),
    getUsdEurRate: jest.fn(),
    buildEuroCostSnapshot: jest.fn(),
}));

const mockedGenerateText = generateText as jest.MockedFunction<typeof generateText>;
const mockedCalculateActualAiCost = calculateActualAiCost as jest.MockedFunction<typeof calculateActualAiCost>;
const mockedGetUsdEurRate = getUsdEurRate as jest.MockedFunction<typeof getUsdEurRate>;
const mockedBuildEuroCostSnapshot = buildEuroCostSnapshot as jest.MockedFunction<typeof buildEuroCostSnapshot>;

describe('paid biography cost telemetry', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockedGenerateText.mockResolvedValue({
            content: 'Biografia aggiornata',
            provider: 'openai',
            model: 'paid-model',
            usage: { input: 120, output: 40, cached: 10 },
            latencyMs: 25,
        });
    });

    it('reports the exact provider and EUR costs to the enclosing credit operation', async () => {
        mockedCalculateActualAiCost.mockReturnValue({
            billable: true,
            pricingAvailable: true,
            costUsd: 0.012,
            inputPricePerMillion: 1,
            outputPricePerMillion: 2,
            cachedInputPricePerMillion: 0.1,
            pricingSource: 'builtin' as const,
        });
        mockedGetUsdEurRate.mockResolvedValue({
            source: 'ECB', usdPerEur: 1.2, rateDate: '2026-08-01', fetchedAt: 1,
        });
        mockedBuildEuroCostSnapshot.mockReturnValue({
            costEur: 0.01,
            usdPerEur: 1.2,
            exchangeRateSource: 'ECB',
            exchangeRateDate: '2026-08-01',
            exchangeRateFetchedAt: 1,
        });
        const onActualCost = jest.fn();

        await generateBio('CHARACTER', {
            name: 'Aria',
            currentDesc: '',
            onActualCost,
        }, [{ description: 'Ha sconfitto il drago', event_type: 'COMBAT' }]);

        expect(mockedCalculateActualAiCost).toHaveBeenCalledWith(
            'openai',
            'paid-model',
            { input: 120, output: 40, cached: 10 },
        );
        expect(onActualCost).toHaveBeenCalledWith({ costUsd: 0.012, costEur: 0.01 });
    });

    it('reports zero without fetching an exchange rate for a local provider', async () => {
        mockedCalculateActualAiCost.mockReturnValue({
            billable: false,
            pricingAvailable: true,
            costUsd: 0,
            inputPricePerMillion: null,
            outputPricePerMillion: null,
            cachedInputPricePerMillion: null,
            pricingSource: 'free' as const,
        });
        const onActualCost = jest.fn();

        await generateBio('CHARACTER', {
            name: 'Aria',
            currentDesc: '',
            onActualCost,
        }, [{ description: 'Ha riposato', event_type: 'REST' }]);

        expect(onActualCost).toHaveBeenCalledWith({ costUsd: 0, costEur: 0 });
        expect(mockedGetUsdEurRate).not.toHaveBeenCalled();
    });
});
