/**
 * Single dispatcher for image generation.
 *
 * It is the sibling of `generate.ts`, not an extension of it: `dispatch()` there
 * is wired to chat completions and returns text, and an image call returns
 * bytes. What it must not be is a second, looser way of reaching a provider —
 * so it reuses the same `ProviderRoute` (credentials mandatory), the same
 * credential-flagging wrapper, and the same cost log towards the monitor.
 *
 * Two transports, for the two providers that hold a BYOK key:
 *  - **openai** — `images.generate`, billed in tokens like everything else there,
 *    and it reports them back in `usage`. With reference pictures it becomes
 *    `images.edit`: as far as that API is concerned, drawing *from* a picture is
 *    an edit, whatever the button in the sheet says;
 *  - **gemini** — two APIs, because Google has two families and they are not
 *    interchangeable. `gemini-*-image` answers `generateContent` with an image
 *    part; `imagen-*` answers `predict`, through `generateImages`. Calling the
 *    wrong one gives a 404 that reads like a missing model, which is exactly how
 *    this shipped broken the first time: the Imagen family is retired for new
 *    accounts, so the only path most tables can use is the one that was missing.
 *
 * Typical use:
 *   const image = await generateImage({
 *       route: await getImageClient(scope),
 *       prompt: '...',
 *       shape: 'portrait',
 *   });
 */

import { toFile } from 'openai';
import { monitor } from '../../monitor';
import { getGeminiAi } from '../geminiNativeGenerate';
import { classifyProviderError, redactKeyLike } from '../ai/providerErrors';
import { flagCredential } from '../ai/credentials';
import type { ProviderRoute } from './generate';
import {
    MAX_REFERENCE_IMAGES,
    buildVisualReferenceContract,
    needsHighInputFidelity,
    validateReferenceCapabilities,
    type ReferenceManifestEntry,
} from '../imageReferences';

export { MAX_REFERENCE_IMAGES } from '../imageReferences';

/**
 * The three framings an entity portrait can want.
 *
 * They come from the media design (`docs/ENTITY-MEDIA-AND-INVENTORY-DESIGN.md`),
 * which already decided how each kind of card displays its picture: generating a
 * square for a slot rendered 4:5 would crop a face in half.
 */
export type ImageShape = 'portrait' | 'landscape' | 'square';

/** How hard the model should work. More is better and costs several times more. */
export type ImageQuality = 'low' | 'medium' | 'high';

/**
 * A picture handed to the model alongside the words.
 *
 * Words are a poor way to specify a look. «Steel cuirass over a long gown» is
 * a sentence a hundred different drawings satisfy; the drawing itself is not.
 * References are what let a table's gallery hold one world, a faction's members
 * wear one uniform, and a regenerated portrait keep the same face.
 */
export interface ReferenceImage extends Partial<ReferenceManifestEntry> {
    bytes: Buffer;
    mimeType: string;
}

interface ResolvedReferenceImage extends ReferenceManifestEntry {
    bytes: Buffer;
    mimeType: string;
}

export interface GenerateImageParams {
    route: ProviderRoute;
    prompt: string;
    shape: ImageShape;
    /** Defaults to `medium`, which is what the price shown to the user assumes. */
    quality?: ImageQuality;
    /**
     * Pictures to draw from in the priority explicitly chosen by the person.
     */
    referenceImages?: ReferenceImage[];
    /** Cost phase for the monitor and for `ai_usage_log`. */
    label?: string;
}

export interface GeneratedImageResult {
    bytes: Buffer;
    mimeType: string;
    provider: string;
    model: string;
    /**
     * Tokens, when the provider bills in them (OpenAI). On a per-image provider
     * every field is 0 and the cost comes from the image count instead — that is
     * what `imageCount` is for.
     */
    usage: { input: number; output: number; cached: number };
    imageCount: number;
    latencyMs: number;
}

/**
 * The provider refused to draw this.
 *
 * Distinct from a network or quota failure, because the answer to the user is
 * different: nothing is wrong with the key or the connection, the prompt is what
 * has to change. Swallowing it and showing "something went wrong" would send
 * someone to check their API key over a phrasing problem.
 */
export class ImageRefusedError extends Error {
    readonly code = 'IMAGE_REFUSED';

    constructor(readonly reason: string) {
        super(`The image provider refused this prompt: ${reason}`);
        this.name = 'ImageRefusedError';
    }
}

/** Pixel sizes per shape, in the buckets the providers actually offer. */
const OPENAI_SIZE: Record<ImageShape, '1024x1024' | '1024x1536' | '1536x1024'> = {
    portrait: '1024x1536',
    landscape: '1536x1024',
    square: '1024x1024',
};

/** Gemini takes a ratio rather than a size, and picks the pixels itself. */
const GEMINI_ASPECT_RATIO: Record<ImageShape, string> = {
    portrait: '3:4',
    landscape: '16:9',
    square: '1:1',
};

/**
 * Resolution, where the model honours the request.
 *
 * The capital K is not decoration: lowercase `2k` is rejected. And the setting
 * is a request, not a guarantee — `gemini-3.1-flash-image` accepts the field and
 * returns ~1K regardless, a reported bug rather than a documented limit. So
 * nothing downstream may assume the pixels it asked for; the transcode step
 * reads the real dimensions off the bytes, as it always has.
 */
const GEMINI_IMAGE_SIZE: Record<ImageQuality, '1K' | '2K'> = {
    low: '1K',
    medium: '1K',
    high: '2K',
};

/**
 * How long to wait before asking again, when the provider itself says it did not
 * draw anything.
 *
 * Two attempts and then out. «This model is currently experiencing high demand»
 * is a 503 that clears in seconds, and a table watching a spinner for four
 * more of them is a far better outcome than the error they actually reported.
 * Waiting longer than this would only turn a fast failure into a slow one.
 */
const UPSTREAM_RETRY_DELAYS_MS = [2_000, 6_000];

export async function generateImage(params: GenerateImageParams): Promise<GeneratedImageResult> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await dispatchImage(params);
        } catch (error) {
            // The same reasoning as in generate.ts: this is the one place an image
            // call passes through, so it is where a dry or revoked key becomes
            // visible in the table's settings. The original error is rethrown, since
            // the retry logic upstream reads `status`/`code`.
            const classified = classifyProviderError(params.route.provider, error);
            if (classified.kind === 'QUOTA_EXHAUSTED' || classified.kind === 'AUTH_FAILED') {
                flagCredential(params.route.creds, classified.kind, redactKeyLike(classified.raw));
                throw error;
            }
            if (attempt >= UPSTREAM_RETRY_DELAYS_MS.length || !worthAnotherAttempt(classified)) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, UPSTREAM_RETRY_DELAYS_MS[attempt]));
        }
    }
}

/**
 * Whether asking again is free of the risk of paying twice.
 *
 * Only when the provider **answered**, with a 5xx of its own: that is a machine
 * on the other side stating it did not serve the request, so there is nothing to
 * be billed for and nothing to lose by retrying.
 *
 * A transport failure with no status — undici's bare `fetch failed` — is
 * deliberately *not* retried here, however transient it looks. It cannot be told
 * apart from a request that arrived, was drawn and was billed, whose response
 * was lost on the way back; retrying that would charge the table twice for one
 * picture, at a dozen cents a time. The person gets an honest «try again» and
 * decides for themselves, which is the same rule the rest of the cost layer
 * follows: never round an unknown in our favour.
 */
function worthAnotherAttempt(classified: ReturnType<typeof classifyProviderError>): boolean {
    return classified.kind === 'UNREACHABLE'
        && classified.status !== null
        && classified.status >= 500;
}

async function dispatchImage(params: GenerateImageParams): Promise<GeneratedImageResult> {
    const { provider, model } = params.route;
    const quality = params.quality ?? 'medium';
    const started = Date.now();
    const references = takeReferences(params);
    validateReferenceCapabilities(provider, model, references);
    const contract = buildVisualReferenceContract(references);
    const prepared = contract
        ? { ...params, prompt: `${params.prompt}\n\n${contract}`, referenceImages: references }
        : { ...params, referenceImages: references };

    const result = provider === 'gemini'
        ? await generateWithGemini(prepared, quality)
        : await generateWithOpenAi(prepared, quality);

    const latencyMs = Date.now() - started;

    // Logged like every other call. On a per-image provider the token counts are
    // genuinely zero, and the euro figure is added later from the image count —
    // see `calculateImageCost` in monitor/costs.ts.
    monitor.logAIRequestWithCost(
        params.label ?? 'image',
        provider,
        model,
        result.usage.input,
        result.usage.output,
        result.usage.cached,
        latencyMs,
        false,
    );

    return { ...result, provider, model, latencyMs };
}

type TransportResult = Omit<GeneratedImageResult, 'provider' | 'model' | 'latencyMs'>;

/** The references that will actually be sent, in order and within the cap. */
function takeReferences(params: GenerateImageParams): ResolvedReferenceImage[] {
    const references = params.referenceImages ?? [];
    if (references.length > MAX_REFERENCE_IMAGES) {
        throw new Error(`At most ${MAX_REFERENCE_IMAGES} reference images may be sent`);
    }
    if (references.some(reference => reference.bytes.length === 0)) {
        throw new Error('A selected reference image is empty');
    }
    return references
        .map((reference, index) => ({
            ...reference,
            id: reference.id ?? `input:${index + 1}`,
            scope: reference.scope ?? 'scratch',
            label: reference.label ?? null,
            // Old in-process callers treated a reference as the whole visual;
            // preserving that meaning is the compatibility path during rollout.
            roles: reference.roles ?? ['whole_image'],
            instruction: reference.instruction ?? null,
            priority: reference.priority ?? index + 1,
        }))
        .sort((a, b) => a.priority - b.priority);
}

function extensionFor(mimeType: string): string {
    if (mimeType === 'image/png') return 'png';
    if (mimeType === 'image/jpeg') return 'jpg';
    return 'webp';
}

async function generateWithOpenAi(
    params: GenerateImageParams,
    quality: ImageQuality,
): Promise<TransportResult> {
    const { client, model } = params.route;
    const references = takeReferences(params);

    // Two endpoints for what is one idea. `images.generate` draws from words
    // alone; the moment there is a picture to draw *from*, the request is an
    // edit as far as this API is concerned, whatever it is called in the UI.
    const editParams: Record<string, unknown> = {
            model,
            prompt: params.prompt,
            image: await Promise.all(references.map((reference, index) => toFile(
                reference.bytes,
                `reference-${index}.${extensionFor(reference.mimeType)}`,
                { type: reference.mimeType },
            ))),
            n: 1,
            size: OPENAI_SIZE[params.shape],
            quality,
            output_format: 'webp',
        };
    const capabilities = validateReferenceCapabilities(params.route.provider, model, references);
    if (capabilities.inputFidelity === 'configurable' && needsHighInputFidelity(references)) {
        editParams.input_fidelity = 'high';
    }

    const response = references.length > 0
        ? await client.images.edit(editParams as never)
        : await client.images.generate({
            model,
            prompt: params.prompt,
            n: 1,
            size: OPENAI_SIZE[params.shape],
            quality,
            // WebP straight from the provider: the transcode step downstream produces
            // WebP anyway, so asking for anything else would only cost a re-encode.
            output_format: 'webp',
        });

    const first = response.data?.[0];
    if (!first?.b64_json) {
        throw new ImageRefusedError(first?.revised_prompt ?? 'the provider returned no image');
    }

    return {
        bytes: Buffer.from(first.b64_json, 'base64'),
        mimeType: 'image/webp',
        // Present for the gpt-image family, absent for the dall-e models; zeros
        // there are the truth, and the per-image price covers them.
        usage: {
            input: response.usage?.input_tokens ?? 0,
            output: response.usage?.output_tokens ?? 0,
            cached: (response.usage?.input_tokens_details as { cached_tokens?: number } | undefined)
                ?.cached_tokens ?? 0,
        },
        imageCount: 1,
    };
}

async function generateWithGemini(
    params: GenerateImageParams,
    quality: ImageQuality,
): Promise<TransportResult> {
    const { creds, model } = params.route;
    const ai = getGeminiAi(creds);

    // Which call this model answers is not a preference: `models.list` reports
    // `predict` for the Imagen family and `generateContent` for the rest, and
    // asking the wrong one returns a 404 that looks like a withdrawn model.
    return model.startsWith('imagen-')
        ? generateWithImagen(ai, params)
        : generateWithGeminiContent(ai, params, quality);
}

/**
 * The `gemini-*-image` family, through `generateContent`.
 *
 * The picture comes back as an inline data part beside any text the model felt
 * like adding, and unlike Imagen it reports token usage — which is the more
 * accurate basis for the cost, though the per-image rate still covers it.
 */
async function generateWithGeminiContent(
    ai: ReturnType<typeof getGeminiAi>,
    params: GenerateImageParams,
    quality: ImageQuality,
): Promise<TransportResult> {
    const references = takeReferences(params);

    const response = await ai.models.generateContent({
        model: params.route.model,
        // References first, prompt last: the words are the instruction and the
        // pictures are the material, and an instruction reads better after the
        // thing it is about.
        contents: references.length > 0
            ? [{
                role: 'user',
                parts: [
                    ...references.flatMap((reference, index) => ([
                        {
                            text: `Input image ${index + 1} follows. Allowed roles: ${reference.roles.join(', ')}.${
                                reference.instruction ? ` Specific instruction: ${reference.instruction}` : ''
                            }`,
                        },
                        {
                            inlineData: {
                                mimeType: reference.mimeType,
                                data: reference.bytes.toString('base64'),
                            },
                        },
                    ])),
                    { text: params.prompt },
                ],
            }]
            : params.prompt,
        config: {
            // TEXT as well as IMAGE, deliberately. Some models in this family
            // answer an image-only request with a written description of the
            // picture instead of the picture — a documented failure mode. Asking
            // for both and taking the image part is the shape that holds across
            // all of them, and the parser below already ignores the prose.
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: {
                aspectRatio: GEMINI_ASPECT_RATIO[params.shape],
                imageSize: GEMINI_IMAGE_SIZE[quality],
            },
        },
    });

    const candidate = response.candidates?.[0];
    const image = candidate?.content?.parts?.find(part => part.inlineData?.data);
    if (!image?.inlineData?.data) {
        // A refusal arrives as a candidate with no picture in it; the finish
        // reason is the closest thing to an explanation the API gives.
        throw new ImageRefusedError(candidate?.finishReason ?? 'the provider returned no image');
    }

    const usage = response.usageMetadata;
    return {
        bytes: Buffer.from(image.inlineData.data, 'base64'),
        mimeType: image.inlineData.mimeType ?? 'image/png',
        usage: {
            input: usage?.promptTokenCount ?? 0,
            output: usage?.candidatesTokenCount ?? 0,
            cached: usage?.cachedContentTokenCount ?? 0,
        },
        imageCount: 1,
    };
}

/**
 * The Imagen family, through `predict`.
 *
 * Kept for the accounts that still have it — Google retired these for new
 * projects, so for most tables this path answers 404 and the family is offered
 * but never recommended.
 */
async function generateWithImagen(
    ai: ReturnType<typeof getGeminiAi>,
    params: GenerateImageParams,
): Promise<TransportResult> {
    const response = await ai.models.generateImages({
        model: params.route.model,
        prompt: params.prompt,
        config: {
            numberOfImages: 1,
            aspectRatio: GEMINI_ASPECT_RATIO[params.shape],
            outputMimeType: 'image/png',
        },
    });

    const first = response.generatedImages?.[0];
    if (first?.raiFilteredReason) throw new ImageRefusedError(first.raiFilteredReason);
    if (!first?.image?.imageBytes) {
        throw new ImageRefusedError('the provider returned no image');
    }

    return {
        bytes: Buffer.from(first.image.imageBytes, 'base64'),
        mimeType: first.image.mimeType ?? 'image/png',
        // Imagen bills per image and reports no tokens. Writing anything but zero
        // here would be inventing a number.
        usage: { input: 0, output: 0, cached: 0 },
        imageCount: 1,
    };
}
