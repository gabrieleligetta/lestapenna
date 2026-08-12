import * as fs from 'fs';
import * as path from 'path';
import { db, initDatabase } from '../../../src/db';
import { modelCatalogRepository } from '../../../src/db/repositories/ModelCatalogRepository';
import {
    mergeWithBuiltin,
    parseLiteLlmImage,
    parseLiteLlmTranscription,
    parseModelsDevText,
    parseModelsDevTranscription,
    runModelCatalogRefresh,
} from '../../../src/services/modelCatalogRefresh';

/**
 * The catalogue refresh, against samples cut from the real payloads.
 *
 * `NOW` is fixed on purpose: the curation drops models older than a year, and a
 * test calibrated on the wall clock would start failing on its own one day
 * without anything having changed.
 */
const NOW = Date.parse('2026-08-05T00:00:00Z');

function fixture(name: string): unknown {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../../fixtures', name), 'utf8'));
}

const modelsDev = fixture('models.dev.sample.json');
const liteLlm = fixture('litellm.prices.sample.json');

describe('Model catalogue refresh — models.dev, text models', () => {
    const records = parseModelsDevText(modelsDev, NOW);
    const ids = records.map(r => r.modelId);

    it('keeps only the providers the API actually offers', () => {
        expect(new Set(records.map(r => r.provider))).toEqual(new Set(['openai', 'gemini']));
        // The sample carries an Anthropic block: it must be ignored, because
        // AI_PROVIDERS does not admit it.
        expect(ids).not.toContain('claude-sonnet-5');
    });

    it('drops models superseded more than a year ago', () => {
        expect(ids).not.toContain('gpt-4.1-nano');   // 2025-04-14
        expect(ids).not.toContain('gemini-2.5-flash'); // 2025-06-17
    });

    it('drops what cannot be priced or costs more than the ceiling', () => {
        expect(ids).not.toContain('gemma-4-31b-it'); // open weights, no rate
        expect(ids).not.toContain('gpt-5-pro');      // $15 per 1M input
    });

    it('drops moving aliases and other modalities', () => {
        expect(ids).not.toContain('gemini-flash-latest');
        expect(ids).not.toContain('gemini-3.5-live-translate-preview');
        expect(ids).not.toContain('gpt-4o-mini-transcribe');
    });

    it('keeps the models the pipeline is configured on', () => {
        expect(ids).toEqual(expect.arrayContaining([
            'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.4-nano',
            'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite',
        ]));
    });

    it('assigns the group by price, on the economics of the two tiers', () => {
        const byId = new Map(records.map(r => [r.modelId, r]));
        expect(byId.get('gpt-5.4-nano')!.tiers).toEqual(['fast']);          // $0.20
        expect(byId.get('gemini-3-flash-preview')!.tiers).toEqual(['fast']); // $0.50
        expect(byId.get('gpt-5.6-sol')!.tiers).toEqual(['quality']);        // $5.00
        expect(byId.get('gemini-3.1-pro-preview')!.tiers).toEqual(['quality']); // $2.00
    });

    it('carries the figures the select has to show', () => {
        const sol = records.find(r => r.modelId === 'gpt-5.6-sol')!;
        expect(sol.inputPerMillion).toBe(5);
        expect(sol.outputPerMillion).toBe(30);
        expect(sol.contextTokens).toBe(1_050_000);
        expect(sol.releaseDate).toBe('2026-07-09');
        expect(sol.perMinuteUsd).toBeNull();
    });

    it('survives a payload that is not what we expect', () => {
        expect(parseModelsDevText(null, NOW)).toEqual([]);
        expect(parseModelsDevText('nonsense', NOW)).toEqual([]);
        expect(parseModelsDevText({ openai: {} }, NOW)).toEqual([]);
    });
});

describe('Model catalogue refresh — transcription', () => {
    const gemini = parseModelsDevTranscription(modelsDev, NOW);
    const openai = parseLiteLlmTranscription(liteLlm, NOW);

    it('takes the Gemini models that accept audio', () => {
        expect(gemini.every(r => r.provider === 'gemini')).toBe(true);
        expect(gemini.map(r => r.modelId)).toEqual(
            expect.arrayContaining(['gemini-3-flash-preview', 'gemini-3.1-flash-lite']),
        );
    });

    it('derives the Gemini per-minute rate at 32 audio tokens per second', () => {
        const flash = gemini.find(r => r.modelId === 'gemini-3-flash-preview')!;
        // $0.50 per 1M × 1920 tokens per minute
        expect(flash.perMinuteUsd).toBeCloseTo(0.00096, 6);
    });

    it('reproduces the per-minute prices OpenAI publishes', () => {
        const byId = new Map(openai.map(r => [r.modelId, r]));
        // Priced per second.
        expect(byId.get('whisper-1')!.perMinuteUsd).toBeCloseTo(0.006, 6);
        // Priced per audio token: 2400 tokens per minute.
        expect(byId.get('gpt-4o-transcribe')!.perMinuteUsd).toBeCloseTo(0.006, 6);
        expect(byId.get('gpt-4o-mini-transcribe')!.perMinuteUsd).toBeCloseTo(0.003, 6);
    });

    it('ignores other vendors, other endpoints and dated snapshots', () => {
        const ids = openai.map(r => r.modelId);
        expect(ids).not.toContain('azure/whisper-1');
        expect(ids).not.toContain('deepgram/nova-3');
        expect(ids).not.toContain('gpt-realtime-whisper');
        expect(ids).not.toContain('gpt-4o-mini-transcribe-2025-03-20');
        expect(ids).not.toContain('gpt-5.6-sol');
    });

    it('survives a payload that is not what we expect', () => {
        expect(parseLiteLlmTranscription(null, NOW)).toEqual([]);
        expect(parseLiteLlmTranscription({ 'x': null }, NOW)).toEqual([]);
    });
});

/**
 * Image models, from the LiteLLM list — the only source that carries them.
 *
 * The samples are cut from the real payload, including the entries that must
 * **not** get through: a reseller's namespace, a size variant, Azure, and a
 * research model the source wrongly marks `image_generation`.
 */
describe('Model catalogue refresh — image models', () => {
    const images = parseLiteLlmImage(liteLlm, NOW);
    const byId = (id: string) => images.find(r => r.modelId === id);

    it('reads the per-picture price a provider publishes', () => {
        expect(byId('imagen-4.0-generate-001')?.perImageUsd).toBeCloseTo(0.04, 4);
        expect(byId('imagen-4.0-fast-generate-001')?.perImageUsd).toBeCloseTo(0.02, 4);
    });

    it('derives one for a model billed in image tokens, and the derivation checks out', () => {
        // 1056 output tokens for a medium 1024x1024 at $40/1M gives $0.042 —
        // exactly what the independent per-pixel entry in the same file yields
        // for `medium/1024-x-1024/gpt-image-1`. Two unrelated figures agreeing
        // is what makes the constant trustworthy.
        expect(byId('gpt-image-1')?.perImageUsd).toBeCloseTo(0.0422, 4);
        expect(byId('gpt-image-1-mini')?.perImageUsd).toBeCloseTo(0.0084, 4);
    });

    it('strips the vendor prefix, because the SDK wants the bare id', () => {
        expect(byId('imagen-4.0-generate-001')?.provider).toBe('gemini');
        expect(images.some(r => r.modelId.includes('/'))).toBe(false);
    });

    it('keeps out what is not a model of its own', () => {
        // A size variant, a reseller, another cloud, a moving alias — four
        // spellings of a choice that already exists, or one we cannot call.
        expect(byId('dall-e-3')).toBeUndefined();
        expect(images.some(r => r.modelId.startsWith('1024-x-1024'))).toBe(false);
        expect(byId('chatgpt-image-latest')).toBeUndefined();
        expect(images.every(r => r.provider === 'openai' || r.provider === 'gemini')).toBe(true);
    });

    it('skips an entry the source itself has miscategorised', () => {
        // The price list marks the deep-research model `image_generation`; it
        // cannot draw, and offering it would be a select option that fails.
        expect(byId('deep-research-pro-preview-12-2025')).toBeUndefined();
    });

    it('drops a -preview sitting next to its stable twin', () => {
        expect(byId('gemini-3.1-flash-image')).toBeDefined();
        expect(byId('gemini-3.1-flash-image-preview')).toBeUndefined();
    });

    it('tags them as image models, with no tier', () => {
        expect(images.every(r => r.kind === 'image')).toBe(true);
        expect(images.every(r => r.tiers.length === 0)).toBe(true);
    });

    it('survives a payload that is not one', () => {
        expect(parseLiteLlmImage(null, NOW)).toEqual([]);
        expect(parseLiteLlmImage({ x: null }, NOW)).toEqual([]);
    });
});

describe('Model catalogue refresh — merge with the curated list', () => {
    const fetched = parseModelsDevText(modelsDev, NOW);
    const merged = mergeWithBuiltin(fetched, NOW);
    const byId = new Map(merged.filter(r => r.kind === 'text').map(r => [r.modelId, r]));

    it('keeps the curated label and recommendation over the downloaded name', () => {
        const terra = byId.get('gpt-5.6-terra')!;
        expect(terra.label).toBe('Equilibrato');
        expect(terra.recommendedFor).toEqual(['quality']);
        expect(terra.inputPerMillion).toBe(2); // the figure still comes from the download
    });

    it('unions the groups, so a recommendation is never for a group the model is not in', () => {
        // The price rule alone would put it in `fast` only; the curated list has
        // it in both.
        expect(byId.get('gpt-5.6-luna')!.tiers.sort()).toEqual(['fast', 'quality']);
    });

    it('keeps a curated model the download did not carry, without inventing a price', () => {
        const orphan = byId.get('gpt-5.4-mini')!;
        expect(orphan.source).toBe('builtin');
        expect(orphan.inputPerMillion).toBeNull();
    });
});

describe('Model catalogue refresh — the job', () => {
    beforeAll(() => {
        initDatabase();
    });

    beforeEach(() => {
        db.prepare('DELETE FROM model_catalog').run();
    });

    const fetcher = async (url: string) =>
        url.includes('models.dev') ? modelsDev : liteLlm;

    it('stores both kinds and stamps the refresh date', async () => {
        const outcome = await runModelCatalogRefresh({ now: NOW, fetcher });

        expect(outcome.sources).toEqual(['models.dev', 'litellm']);
        expect(outcome.text).toBeGreaterThan(0);
        expect(outcome.transcription).toBeGreaterThan(0);
        expect(modelCatalogRepository.refreshedAt()).toBe(NOW);
        expect(modelCatalogRepository.list('transcription', 'openai').map(r => r.modelId))
            .toContain('gpt-4o-mini-transcribe');
    });

    it('rebuilds from the one source that answered', async () => {
        const halfDown = async (url: string) => {
            if (url.includes('models.dev')) throw new Error('boom');
            return liteLlm;
        };
        const outcome = await runModelCatalogRefresh({ now: NOW, fetcher: halfDown });

        expect(outcome.sources).toEqual(['litellm']);
        expect(modelCatalogRepository.list('transcription', 'openai').length).toBeGreaterThan(0);
    });

    it('leaves a working catalogue alone when every source is down', async () => {
        await runModelCatalogRefresh({ now: NOW, fetcher });
        const before = modelCatalogRepository.list('text').length;

        const allDown = async () => { throw new Error('offline'); };
        const outcome = await runModelCatalogRefresh({ now: NOW, fetcher: allDown });

        expect(outcome.sources).toEqual([]);
        expect(modelCatalogRepository.list('text').length).toBe(before);
    });
});
