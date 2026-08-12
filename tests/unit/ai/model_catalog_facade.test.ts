import { db, initDatabase } from '../../../src/db';
import {
    modelCatalogRepository,
    type CatalogRecord,
} from '../../../src/db/repositories/ModelCatalogRepository';
import {
    catalogPricing,
    modelsFor,
    providerOfTranscriptionModel,
    transcriptionModelsFor,
    transcriptionPricePerMinute,
} from '../../../src/bard/ai/modelCatalog';

/**
 * The catalogue is a cache and the curated list is the floor.
 *
 * These are the guarantees that let an instance with no network keep a working
 * settings page, which is the whole reason the committed list still exists.
 */

function record(overrides: Partial<CatalogRecord> = {}): CatalogRecord {
    return {
        provider: 'openai',
        modelId: 'gpt-from-catalogue',
        kind: 'text',
        label: 'From the catalogue',
        tiers: ['fast'],
        recommendedFor: [],
        inputPerMillion: 0.5,
        outputPerMillion: 1.5,
        cachedInputPerMillion: 0.05,
        perMinuteUsd: null,
        perImageUsd: null,
        contextTokens: 400_000,
        maxOutputTokens: null,
        releaseDate: null,
        source: 'models.dev',
        refreshedAt: 1_000,
        ...overrides,
    };
}

describe('Model catalogue facade', () => {
    beforeAll(() => {
        initDatabase();
    });

    beforeEach(() => {
        db.prepare('DELETE FROM model_catalog').run();
    });

    describe('with an empty catalogue', () => {
        it('answers with the curated list rather than an empty select', () => {
            const options = modelsFor('openai', 'quality');
            expect(options.length).toBeGreaterThan(0);
            expect(options.map(o => o.id)).toContain('gpt-5.6-terra');
        });

        it('still prices what the committed table knows', () => {
            // The rates committed in `monitor/costs.ts`, which the refresh exists
            // to correct: it currently reads $2/$12 for this model, and the
            // difference is the drift a hand-maintained list accumulates.
            const terra = modelsFor('openai', 'quality').find(o => o.id === 'gpt-5.6-terra')!;
            expect(terra.inputPerMillion).toBe(2.5);
            expect(terra.outputPerMillion).toBe(15);
        });

        it('says Ollama runs on your hardware instead of pricing it at zero', () => {
            const [option] = modelsFor('ollama', 'quality');
            expect(option.runsOnYourHardware).toBe(true);
            expect(option.inputPerMillion).toBeNull();
        });

        it('still knows which provider owns a transcription model', () => {
            expect(providerOfTranscriptionModel('whisper-1')).toBe('openai');
            expect(providerOfTranscriptionModel('gemini-3.6-flash')).toBe('gemini');
            expect(providerOfTranscriptionModel('made-up')).toBeNull();
        });

        it('falls back to the committed per-minute rates', () => {
            expect(transcriptionPricePerMinute('whisper-1')).toBe(0.006);
            expect(transcriptionPricePerMinute('made-up')).toBeNull();
        });
    });

    describe('with a refreshed catalogue', () => {
        it('serves it instead of the curated list', () => {
            modelCatalogRepository.replaceAll([record()]);

            const options = modelsFor('openai', 'fast');
            expect(options.map(o => o.id)).toEqual(['gpt-from-catalogue']);
            expect(options[0].contextTokens).toBe(400_000);
        });

        it('keeps the tier separation', () => {
            modelCatalogRepository.replaceAll([record({ tiers: ['quality'] })]);

            expect(modelsFor('openai', 'quality').map(o => o.id)).toEqual(['gpt-from-catalogue']);
            // Nothing in `fast`, so the curated list answers for that group only.
            expect(modelsFor('openai', 'fast').map(o => o.id)).not.toContain('gpt-from-catalogue');
        });

        it('prices a model the committed table has never heard of', () => {
            modelCatalogRepository.replaceAll([record({ modelId: 'released-last-week' })]);

            expect(catalogPricing('released-last-week')).toEqual({
                input: 0.5, output: 1.5, cachedInput: 0.05,
            });
        });

        it('prices Gemini transcription, which the committed table never covered', () => {
            modelCatalogRepository.replaceAll([record({
                provider: 'gemini',
                modelId: 'gemini-3-flash-preview',
                kind: 'transcription',
                tiers: [],
                perMinuteUsd: 0.00096,
            })]);

            expect(transcriptionPricePerMinute('gemini-3-flash-preview')).toBeCloseTo(0.00096, 6);
            expect(transcriptionModelsFor('gemini').map(o => o.id)).toEqual(['gemini-3-flash-preview']);
        });

        it('reports no per-token price for something billed per minute', () => {
            modelCatalogRepository.replaceAll([record({
                modelId: 'whisper-1',
                kind: 'transcription',
                tiers: [],
                inputPerMillion: null,
                outputPerMillion: null,
                perMinuteUsd: 0.006,
            })]);

            expect(catalogPricing('whisper-1')).toBeNull();
        });
    });
});
