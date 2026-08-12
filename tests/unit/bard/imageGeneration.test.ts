/**
 * The image route.
 *
 * It is a second way of reaching a provider, so what matters most here is that
 * it did not become a looser one: the same credential flagging, the same cost
 * log, the same rethrow of the original error. A refusal is its own outcome,
 * because the answer to the user differs — nothing is wrong with the key.
 */

const mockLogAIRequestWithCost: any = jest.fn();
jest.mock('../../../src/monitor', () => ({
    monitor: { logAIRequestWithCost: (...args: unknown[]) => mockLogAIRequestWithCost(...args) },
}));

const mockFlagCredential: any = jest.fn();
jest.mock('../../../src/bard/ai/credentials', () => ({
    flagCredential: (...args: unknown[]) => mockFlagCredential(...args),
}));

const mockGenerateImages: any = jest.fn();
const mockGenerateContent: any = jest.fn();
jest.mock('../../../src/bard/geminiNativeGenerate', () => ({
    getGeminiAi: () => ({
        models: {
            generateImages: (...a: unknown[]) => mockGenerateImages(...a),
            generateContent: (...a: unknown[]) => mockGenerateContent(...a),
        },
    }),
}));

import { generateImage, ImageRefusedError, MAX_REFERENCE_IMAGES } from '../../../src/bard/llm/image';
import type { ProviderRoute } from '../../../src/bard/llm/generate';

const scope = { guildId: 'g1' };
const creds = { provider: 'openai', apiKey: null, source: 'tenant', secretKey: 'openai.apiKey', scope } as any;

function openAiRoute(images: { images: { generate: any } }): ProviderRoute {
    return { client: images as any, model: 'gpt-image-1', provider: 'openai', creds, scope } as ProviderRoute;
}

function geminiRoute(model = 'imagen-4.0-generate-001'): ProviderRoute {
    return {
        client: {} as any,
        model,
        provider: 'gemini',
        creds: { ...creds, provider: 'gemini' },
        scope,
    } as ProviderRoute;
}

/** A 1×1 WebP is enough: nothing here decodes the bytes. */
const PIXEL = Buffer.from('a picture').toString('base64');

beforeEach(() => {
    jest.clearAllMocks();
});

describe('generateImage', () => {
    it('returns the bytes and the real token usage on OpenAI', async () => {
        const generate = (jest.fn() as any).mockResolvedValue({
            data: [{ b64_json: PIXEL }],
            usage: { input_tokens: 30, output_tokens: 1056, input_tokens_details: { text_tokens: 12 } },
        });

        const result = await generateImage({
            route: openAiRoute({ images: { generate } }),
            prompt: 'a stern elven prince',
            shape: 'portrait',
        });

        expect(result.bytes.toString()).toBe('a picture');
        expect(result.mimeType).toBe('image/webp');
        expect(result.usage).toEqual({ input: 30, output: 1056, cached: 12 });
        expect(result.imageCount).toBe(1);

        // The shape decides the size asked for: a portrait slot rendered 4:5
        // must not be filled with a square that crops the face.
        expect(generate).toHaveBeenCalledWith(expect.objectContaining({
            model: 'gpt-image-1',
            size: '1024x1536',
            n: 1,
            output_format: 'webp',
        }));
    });

    it('reports zero tokens on a per-image provider rather than inventing them', async () => {
        mockGenerateImages.mockResolvedValue({
            generatedImages: [{ image: { imageBytes: PIXEL, mimeType: 'image/png' } }],
        });

        const result = await generateImage({
            route: geminiRoute('imagen-4.0-generate-001'),
            prompt: 'a windswept moor',
            shape: 'landscape',
        });

        expect(result.usage).toEqual({ input: 0, output: 0, cached: 0 });
        expect(result.imageCount).toBe(1);
        expect(mockGenerateImages).toHaveBeenCalledWith(expect.objectContaining({
            config: expect.objectContaining({ aspectRatio: '16:9', numberOfImages: 1 }),
        }));
    });

    /**
     * Google has two image families and they answer different calls.
     *
     * `models.list` reports `predict` for `imagen-*` and `generateContent` for
     * the rest. Sending the whole family down the Imagen path is how this
     * shipped broken: the Imagen models are retired for new accounts, so the
     * only route most tables can use was the one that did not exist.
     */
    it('calls the gemini-image family through generateContent, not predict', async () => {
        mockGenerateContent.mockResolvedValue({
            candidates: [{ content: { parts: [
                { text: 'Here is your portrait.' },
                { inlineData: { data: PIXEL, mimeType: 'image/jpeg' } },
            ] } }],
            usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1529, cachedContentTokenCount: 0 },
        });

        const result = await generateImage({
            route: geminiRoute('gemini-3.1-flash-image'),
            prompt: 'a stern elven prince',
            shape: 'portrait',
        });

        expect(mockGenerateImages).not.toHaveBeenCalled();
        expect(result.bytes.toString()).toBe('a picture');
        expect(result.mimeType).toBe('image/jpeg');
        // This family does report tokens, unlike Imagen.
        expect(result.usage).toEqual({ input: 12, output: 1529, cached: 0 });
        expect(mockGenerateContent).toHaveBeenCalledWith(expect.objectContaining({
            config: expect.objectContaining({
                // Both modalities: asking for IMAGE alone makes some models in
                // this family answer with a written description instead.
                responseModalities: ['TEXT', 'IMAGE'],
                imageConfig: expect.objectContaining({ aspectRatio: '3:4' }),
            }),
        }));
    });

    it('still uses predict for the Imagen family, which some accounts still have', async () => {
        mockGenerateImages.mockResolvedValue({
            generatedImages: [{ image: { imageBytes: PIXEL, mimeType: 'image/png' } }],
        });

        await generateImage({
            route: geminiRoute('imagen-4.0-generate-001'),
            prompt: 'a windswept moor',
            shape: 'landscape',
        });

        expect(mockGenerateContent).not.toHaveBeenCalled();
        expect(mockGenerateImages).toHaveBeenCalled();
    });

    it('treats a text-only answer from an image model as a refusal', async () => {
        mockGenerateContent.mockResolvedValue({
            candidates: [{ content: { parts: [{ text: 'A description instead of a picture.' }] }, finishReason: 'STOP' }],
        });

        await expect(generateImage({
            route: geminiRoute('gemini-3.1-flash-image'),
            prompt: 'anything',
            shape: 'square',
        })).rejects.toBeInstanceOf(ImageRefusedError);
    });

    it('logs the call to the monitor like every other one', async () => {
        const generate = (jest.fn() as any).mockResolvedValue({
            data: [{ b64_json: PIXEL }],
            usage: { input_tokens: 5, output_tokens: 1056 },
        });

        await generateImage({
            route: openAiRoute({ images: { generate } }),
            prompt: 'a rusted key',
            shape: 'square',
        });

        expect(mockLogAIRequestWithCost).toHaveBeenCalledWith(
            'image', 'openai', 'gpt-image-1', 5, 1056, 0, expect.any(Number), false,
        );
    });

    it('flags the credential on an exhausted quota and rethrows the original error', async () => {
        // OpenAI sends 429 for both a rate limit and a dry key; only the code
        // tells them apart, and the retry logic upstream reads `status`.
        const quota = Object.assign(new Error('You exceeded your current quota'), {
            status: 429,
            code: 'insufficient_quota',
        });
        const generate = (jest.fn() as any).mockRejectedValue(quota);

        await expect(generateImage({
            route: openAiRoute({ images: { generate } }),
            prompt: 'anything',
            shape: 'portrait',
        })).rejects.toBe(quota);

        expect(mockFlagCredential).toHaveBeenCalledWith(
            expect.anything(), 'QUOTA_EXHAUSTED', expect.any(String),
        );
    });

    it('does not flag the credential on an ordinary failure', async () => {
        // A 400 rather than a 5xx: an upstream 5xx is retried now, and this
        // test is about the credential, not about how many attempts it takes.
        const boom = Object.assign(new Error('that model does not exist'), { status: 400 });
        const generate = (jest.fn() as any).mockRejectedValue(boom);

        await expect(generateImage({
            route: openAiRoute({ images: { generate } }),
            prompt: 'anything',
            shape: 'portrait',
        })).rejects.toBe(boom);

        expect(mockFlagCredential).not.toHaveBeenCalled();
    });

    it('tells a refusal apart from a failure', async () => {
        // Nothing is wrong with the key or the network: the prompt is what has
        // to change, and sending someone to check their API key would waste
        // their time on the wrong thing.
        mockGenerateImages.mockResolvedValue({
            generatedImages: [{ raiFilteredReason: 'blocked by the safety filter' }],
        });

        await expect(generateImage({
            route: geminiRoute('imagen-4.0-generate-001'),
            prompt: 'something the provider dislikes',
            shape: 'portrait',
        })).rejects.toBeInstanceOf(ImageRefusedError);

        expect(mockFlagCredential).not.toHaveBeenCalled();
    });

    it('treats an empty response as a refusal rather than crashing', async () => {
        const generate = (jest.fn() as any).mockResolvedValue({ data: [] });

        await expect(generateImage({
            route: openAiRoute({ images: { generate } }),
            prompt: 'anything',
            shape: 'square',
        })).rejects.toBeInstanceOf(ImageRefusedError);
    });
});

/**
 * Reference pictures.
 *
 * Words are a poor way to pin down a look: «steel cuirass over a long gown» is
 * satisfied by a hundred different drawings, and a portrait regenerated from
 * words alone comes back with a different face. What matters here is that the
 * references travel in the order they were given — house style, then livery,
 * then the subject's own last portrait — and that a request without them is
 * left exactly as it was.
 */
describe('reference images', () => {
    const reference = (label: string) => ({
        bytes: Buffer.from(label),
        mimeType: 'image/webp',
        label,
    });

    it('sends them to Gemini before the words, in order', async () => {
        mockGenerateContent.mockResolvedValue({
            candidates: [{ content: { parts: [{ inlineData: { data: PIXEL, mimeType: 'image/png' } }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1600 },
        });

        await generateImage({
            route: geminiRoute('gemini-3-pro-image'),
            prompt: 'her portrait',
            shape: 'portrait',
            referenceImages: [reference('house style'), reference('livery'), reference('her last portrait')],
        });

        const parts = mockGenerateContent.mock.calls[0][0].contents[0].parts;
        expect(parts.map((part: any) => part.inlineData && Buffer.from(part.inlineData.data, 'base64').toString()))
            .toEqual(['house style', 'livery', 'her last portrait', undefined]);
        // The instruction reads after the material it is about.
        expect(parts[parts.length - 1].text).toBe('her portrait');
    });

    it('leaves a request without references exactly as it was', async () => {
        mockGenerateContent.mockResolvedValue({
            candidates: [{ content: { parts: [{ inlineData: { data: PIXEL, mimeType: 'image/png' } }] } }],
            usageMetadata: {},
        });

        await generateImage({
            route: geminiRoute('gemini-3-pro-image'),
            prompt: 'her portrait',
            shape: 'portrait',
        });

        expect(mockGenerateContent.mock.calls[0][0].contents).toBe('her portrait');
    });

    it('caps them, because every reference is input tokens on the table\'s account', async () => {
        mockGenerateContent.mockResolvedValue({
            candidates: [{ content: { parts: [{ inlineData: { data: PIXEL, mimeType: 'image/png' } }] } }],
            usageMetadata: {},
        });

        await generateImage({
            route: geminiRoute('gemini-3-pro-image'),
            prompt: 'her portrait',
            shape: 'portrait',
            referenceImages: Array.from({ length: 12 }, (_, index) => reference(`ref-${index}`)),
        });

        const parts = mockGenerateContent.mock.calls[0][0].contents[0].parts;
        expect(parts.filter((part: any) => part.inlineData)).toHaveLength(MAX_REFERENCE_IMAGES);
    });

    it('asks for a bigger picture only where the model honours the request', async () => {
        mockGenerateContent.mockResolvedValue({
            candidates: [{ content: { parts: [{ inlineData: { data: PIXEL, mimeType: 'image/png' } }] } }],
            usageMetadata: {},
        });

        await generateImage({
            route: geminiRoute('gemini-3-pro-image'),
            prompt: 'her portrait',
            shape: 'portrait',
            quality: 'high',
        });

        // Capitalised: lowercase "2k" is rejected outright.
        expect(mockGenerateContent.mock.calls[0][0].config.imageConfig.imageSize).toBe('2K');
    });

    it('turns an OpenAI request with references into an edit', async () => {
        // Drawing *from* a picture is an edit as far as that API is concerned,
        // whatever the button in the sheet says.
        const generate = jest.fn();
        const edit = (jest.fn() as any).mockResolvedValue({ data: [{ b64_json: PIXEL }], usage: {} });

        await generateImage({
            route: { ...openAiRoute({ images: { generate } }), client: { images: { generate, edit } } } as any,
            prompt: 'her portrait',
            shape: 'portrait',
            referenceImages: [reference('her last portrait')],
        });

        expect(generate).not.toHaveBeenCalled();
        expect(edit).toHaveBeenCalledTimes(1);
        expect(edit.mock.calls[0][0].image).toHaveLength(1);
    });
});

/**
 * Asking again when the provider says it drew nothing.
 *
 * The line this feature was reported on: «This model is currently experiencing
 * high demand… please try again later». It clears in seconds, and the person
 * clicking is watching a spinner anyway — but only when the provider *answered*,
 * because a request that died in transit may already have been drawn and billed.
 */
describe('a provider having a bad minute', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    /** Exactly what the Google SDK throws for a failed response. */
    function apiError(status: number, message: string): Error {
        const error: any = new Error(JSON.stringify({ error: { code: status, message } }));
        error.status = status;
        return error;
    }

    /** Runs the call to completion with every retry delay elapsed instantly. */
    async function settled<T>(work: Promise<T>): Promise<T> {
        const outcome = work.then(value => ({ value }), (error: unknown) => ({ error }));
        await jest.runAllTimersAsync();
        const result = await outcome as { value?: T; error?: unknown };
        if ('error' in result && result.error !== undefined) throw result.error;
        return result.value as T;
    }

    it('asks again after a 503, and returns the picture the second time', async () => {
        mockGenerateContent
            .mockRejectedValueOnce(apiError(503, 'This model is currently experiencing high demand.'))
            .mockResolvedValueOnce({
                candidates: [{ content: { parts: [{ inlineData: { data: PIXEL, mimeType: 'image/png' } }] } }],
                usageMetadata: {},
            });

        const result = await settled(generateImage({
            route: geminiRoute('gemini-3-pro-image'),
            prompt: 'her portrait',
            shape: 'portrait',
        }));

        expect(result.bytes.toString()).toBe('a picture');
        expect(mockGenerateContent).toHaveBeenCalledTimes(2);
        // One picture asked for, one picture logged: the failed attempt drew
        // nothing and must not appear in anybody's ledger.
        expect(mockLogAIRequestWithCost).toHaveBeenCalledTimes(1);
    });

    it('gives up rather than retrying forever, and rethrows the provider error', async () => {
        mockGenerateContent.mockRejectedValue(apiError(503, 'still busy'));

        await expect(settled(generateImage({
            route: geminiRoute('gemini-3-pro-image'),
            prompt: 'her portrait',
            shape: 'portrait',
        }))).rejects.toMatchObject({ status: 503 });

        expect(mockGenerateContent).toHaveBeenCalledTimes(3);
        expect(mockLogAIRequestWithCost).not.toHaveBeenCalled();
    });

    it('does not retry a transport failure, which may already have been billed', async () => {
        // `fetch failed` cannot be told apart from a picture that was drawn and
        // whose response was lost. Retrying it would charge the table twice.
        const dropped: any = new TypeError('fetch failed');
        dropped.cause = { code: 'UND_ERR_SOCKET' };
        mockGenerateContent.mockRejectedValue(dropped);

        await expect(settled(generateImage({
            route: geminiRoute('gemini-3-pro-image'),
            prompt: 'her portrait',
            shape: 'portrait',
        }))).rejects.toThrow('fetch failed');

        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('does not retry a refusal or a dead key', async () => {
        mockGenerateContent.mockRejectedValue(apiError(401, 'API key not valid'));

        await expect(settled(generateImage({
            route: geminiRoute('gemini-3-pro-image'),
            prompt: 'her portrait',
            shape: 'portrait',
        }))).rejects.toMatchObject({ status: 401 });

        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
        expect(mockFlagCredential).toHaveBeenCalledTimes(1);
    });
});
