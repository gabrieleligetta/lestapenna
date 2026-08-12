import { db, initDatabase } from '../../../src/db';
import {
    modelCatalogRepository,
    type CatalogRecord,
} from '../../../src/db/repositories/ModelCatalogRepository';

function entry(overrides: Partial<CatalogRecord> = {}): CatalogRecord {
    return {
        provider: 'openai',
        modelId: 'gpt-test',
        kind: 'text',
        label: null,
        tiers: ['fast'],
        recommendedFor: [],
        inputPerMillion: 1,
        outputPerMillion: 2,
        cachedInputPerMillion: null,
        perMinuteUsd: null,
        perImageUsd: null,
        contextTokens: null,
        maxOutputTokens: null,
        releaseDate: null,
        source: 'models.dev',
        refreshedAt: 1_000,
        ...overrides,
    };
}

describe('Model catalogue repository', () => {
    beforeAll(() => {
        initDatabase();
    });

    beforeEach(() => {
        db.prepare('DELETE FROM model_catalog').run();
    });

    it('reports an empty catalogue so the builtin list can take over', () => {
        expect(modelCatalogRepository.isEmpty()).toBe(true);
        expect(modelCatalogRepository.refreshedAt()).toBeNull();
        expect(modelCatalogRepository.list('text')).toEqual([]);
    });

    it('round-trips a record, tiers included', () => {
        modelCatalogRepository.replaceAll([entry({
            modelId: 'gpt-5.6-terra',
            label: 'Equilibrato',
            tiers: ['quality', 'fast'],
            recommendedFor: ['quality'],
            contextTokens: 1_050_000,
        })]);

        const [record] = modelCatalogRepository.list('text');
        expect(record.modelId).toBe('gpt-5.6-terra');
        expect(record.tiers).toEqual(['quality', 'fast']);
        expect(record.recommendedFor).toEqual(['quality']);
        expect(record.contextTokens).toBe(1_050_000);
        expect(modelCatalogRepository.refreshedAt()).toBe(1_000);
    });

    it('keeps an unknown price as null rather than turning it into zero', () => {
        modelCatalogRepository.replaceAll([entry({
            inputPerMillion: null,
            outputPerMillion: null,
        })]);

        const [record] = modelCatalogRepository.list('text');
        expect(record.inputPerMillion).toBeNull();
        expect(record.outputPerMillion).toBeNull();
    });

    it('drops models withdrawn by the provider instead of keeping them forever', () => {
        modelCatalogRepository.replaceAll([
            entry({ modelId: 'kept' }),
            entry({ modelId: 'withdrawn' }),
        ]);
        modelCatalogRepository.replaceAll([entry({ modelId: 'kept' })]);

        expect(modelCatalogRepository.list('text').map(r => r.modelId)).toEqual(['kept']);
    });

    it('leaves the previous catalogue untouched when a replacement fails halfway', () => {
        modelCatalogRepository.replaceAll([entry({ modelId: 'original' })]);

        // Same primary key twice: the second insert violates the constraint
        // partway through, so the whole swap must roll back.
        expect(() => modelCatalogRepository.replaceAll([
            entry({ modelId: 'newcomer' }),
            entry({ modelId: 'newcomer' }),
        ])).toThrow();

        expect(modelCatalogRepository.list('text').map(r => r.modelId)).toEqual(['original']);
    });

    it('separates the two billing units and orders each by price', () => {
        modelCatalogRepository.replaceAll([
            entry({ modelId: 'expensive', inputPerMillion: 5 }),
            entry({ modelId: 'cheap', inputPerMillion: 0.2 }),
            entry({
                modelId: 'whisper-1',
                kind: 'transcription',
                inputPerMillion: null,
                outputPerMillion: null,
                perMinuteUsd: 0.006,
                tiers: [],
            }),
        ]);

        expect(modelCatalogRepository.list('text').map(r => r.modelId)).toEqual(['cheap', 'expensive']);
        const transcription = modelCatalogRepository.list('transcription');
        expect(transcription).toHaveLength(1);
        expect(transcription[0].perMinuteUsd).toBe(0.006);
    });

    it('filters by provider', () => {
        modelCatalogRepository.replaceAll([
            entry({ provider: 'openai', modelId: 'gpt' }),
            entry({ provider: 'gemini', modelId: 'gemini' }),
        ]);

        expect(modelCatalogRepository.list('text', 'gemini').map(r => r.modelId)).toEqual(['gemini']);
    });
});
