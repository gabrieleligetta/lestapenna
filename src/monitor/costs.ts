/**
 * Monitor - Costs Logic
 */

// Prices per 1M tokens (OpenAI + Gemini + Anthropic).
// IMPORTANT for the per-prefix fallback in calculateCost(): insertion order matters,
// because Object.keys(...).find(k => model.startsWith(k)) stops at the first match. More
// specific/recent keys must always come BEFORE any generic/older key that would
// contain them as a prefix (e.g. 'gpt-5' is a prefix of 'gpt-5.6-sol' or 'gpt-5.5-...').
const OPENAI_PRICING: Record<string, { input: number; output: number; cachedInput: number }> = {
    // OpenAI — current models. Source: https://developers.openai.com/api/docs/pricing
    'gpt-5.6-sol':   { input: 5.00,  output: 30.00, cachedInput: 0.50  }, // Flagship
    'gpt-5.6-terra': { input: 2.50,  output: 15.00, cachedInput: 0.25  }, // Mid
    'gpt-5.6-luna':  { input: 1.00,  output: 6.00,  cachedInput: 0.10  }, // Light
    'gpt-5.5':       { input: 5.00,  output: 30.00, cachedInput: 0.50  },
    'gpt-5.4-mini':  { input: 0.75,  output: 4.50,  cachedInput: 0.075 },
    'gpt-5.4-nano':  { input: 0.20,  output: 1.25,  cachedInput: 0.02  },
    'gpt-5.4':       { input: 2.50,  output: 15.00, cachedInput: 0.25  },
    'text-embedding-3-small': { input: 0.020, output: 0, cachedInput: 0 },
    'text-embedding-3-large': { input: 0.130, output: 0, cachedInput: 0 },
    // OpenAI — legacy, no longer listed on the current pricing page but kept as a
    // fallback for deployments/configs that still reference them explicitly.
    'gpt-5-nano': { input: 0.05, output: 0.40, cachedInput: 0.005 },
    'gpt-5-mini': { input: 0.25, output: 2.00, cachedInput: 0.025 },
    'gpt-5.2': { input: 1.75, output: 14.00, cachedInput: 0.175 },
    'gpt-5': { input: 1.25, output: 10.00, cachedInput: 0.125 },
    'gpt-4o-mini': { input: 0.15, output: 0.60, cachedInput: 0.075 },
    'gpt-4o': { input: 2.50, output: 10.00, cachedInput: 1.25 },
    // Gemini — prezzi ufficiali /1M token (tier a pagamento, prompt ≤200k token)
    // Fonte: https://ai.google.dev/gemini-api/docs/pricing
    'gemini-3.5-flash':       { input: 1.50,  output: 9.00,  cachedInput: 0.15  },
    'gemini-3.1-pro-preview': { input: 2.00,  output: 12.00, cachedInput: 0.20  },
    'gemini-3.1-flash-lite':  { input: 0.25,  output: 1.50,  cachedInput: 0.025 }, // GEMINI_LIGHT_MODEL di default
    'gemini-3-pro-preview':   { input: 2.00,  output: 12.00, cachedInput: 0.20  },
    'gemini-3-flash-preview': { input: 0.50,  output: 3.00,  cachedInput: 0.05  },
    'gemini-2.5-pro':         { input: 1.25,  output: 10.00, cachedInput: 0.125 },
    'gemini-2.5-flash':       { input: 0.30,  output: 2.50,  cachedInput: 0.03  },
    'gemini-2.5-flash-lite':  { input: 0.10,  output: 0.40,  cachedInput: 0.01  },
    'gemini-embedding-001':   { input: 0.15,  output: 0,     cachedInput: 0     },
    // Legacy
    'gemini-2.5-pro-preview': { input: 1.25,  output: 10.00, cachedInput: 0.125 },
    'gemini-2.0-flash':       { input: 0.10,  output: 0.40,  cachedInput: 0.025 },
    // Anthropic — official prices per 1M tokens (cachedInput = cache read, 0.1x input).
    // Source: https://platform.claude.com/docs/en/about-claude/pricing
    // Note: Claude Sonnet 5 has an introductory price of $2/$10 until 2026-08-31, then $3/$15 (used here).
    'claude-fable-5':           { input: 10.00, output: 50.00, cachedInput: 1.00 },
    'claude-opus-4-8':          { input: 5.00,  output: 25.00, cachedInput: 0.50 },
    'claude-sonnet-5':          { input: 3.00,  output: 15.00, cachedInput: 0.30 },
    'claude-haiku-4-5':         { input: 1.00,  output: 5.00,  cachedInput: 0.10 },
    'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00,  cachedInput: 0.10 },
};

/**
 * Cloud transcription: billed **per minute of audio**, not per token.
 *
 * That is a different unit from everything else in the price list, and keeping
 * it in a separate table stops `resolvePricing` from returning a per-token
 * price for a model that consumes none — that is, a figure wrong by orders of
 * magnitude on what, for a four-hour session, is often the largest line item.
 *
 * USD per minute of audio.
 */
export const TRANSCRIPTION_PRICING: Record<string, number> = {
    'gpt-4o-mini-transcribe': 0.003,
    'gpt-4o-transcribe': 0.006,
    'whisper-1': 0.006,
};

/** Per-minute rate of a transcription model, or `null` when we do not know it. */
export function resolveTranscriptionPricing(model: string): number | null {
    return TRANSCRIPTION_PRICING[model] ?? null;
}

/**
 * Cost of a cloud transcription.
 *
 * On the table's own hardware it is €0 — and that should be stated, not
 * omitted: it still costs time and electricity, and the user must be able to
 * compare the two routes.
 */
export function calculateTranscriptionCost(model: string, audioSeconds: number): number | null {
    const perMinute = resolveTranscriptionPricing(model);
    if (perMinute === null) return null;
    return (audioSeconds / 60) * perMinute;
}

/**
 * Image generation: billed **per image**, or per image-token.
 *
 * A third unit, kept in a third table for the same reason transcription has its
 * own: `resolvePricing` would otherwise answer a per-token rate for a call that
 * consumes none, and be wrong by two orders of magnitude on the single most
 * expensive action in the product.
 *
 * USD per generated image, at medium quality and the ~1 megapixel sizes this app
 * asks for. Figures from the LiteLLM price list, the same source the nightly
 * catalogue refresh reads; this table is the committed fallback for an instance
 * that has never reached the network.
 */
export const IMAGE_PRICING: Record<string, number> = {
    // OpenAI bills these in image tokens; the per-image figures below are the
    // published output-token counts for a 1024×1024 at each quality times the
    // per-token rate, and they reproduce OpenAI's own per-image numbers exactly
    // (see IMAGE_OUTPUT_TOKENS below for the check).
    'gpt-image-2': 0.032,
    'gpt-image-1.5': 0.034,
    'gpt-image-1': 0.042,
    'gpt-image-1-mini': 0.008,
    // Gemini publishes a per-image price directly.
    'gemini-3.1-flash-image': 0.045,
    'gemini-3.1-flash-lite-image': 0.02,
    'gemini-3-pro-image': 0.134,
    'gemini-2.5-flash-image': 0.039,
    'imagen-4.0-ultra-generate-001': 0.06,
    'imagen-4.0-generate-001': 0.04,
    'imagen-4.0-fast-generate-001': 0.02,
};

/**
 * Output image tokens for one 1024×1024 image, per quality.
 *
 * These are OpenAI's published counts, and they are **verified rather than
 * assumed**: multiplied by `gpt-image-1`'s $40/1M image-output rate they give
 * $0.011 / $0.042 / $0.167, which is exactly what the independent per-pixel
 * entries in the LiteLLM list yield for the low/medium/high 1024×1024 variants.
 * Two unrelated figures agreeing is what makes the derivation trustworthy — the
 * same check the transcription tokens-per-minute constants carry.
 */
export const IMAGE_OUTPUT_TOKENS: Record<'low' | 'medium' | 'high', number> = {
    low: 272,
    medium: 1056,
    high: 4160,
};

/** Per-image rate of an image model, or `null` when we do not know it. */
export function resolveImagePricing(model: string): number | null {
    return IMAGE_PRICING[model] ?? null;
}

/**
 * Cost of generating `images` pictures with a model.
 *
 * `null`, never 0, when the rate is unknown: on the most expensive click in the
 * product, answering "free" to "we do not know" would be the worst possible
 * place to do it.
 */
export function calculateImageCost(model: string, images: number): number | null {
    const perImage = resolveImagePricing(model);
    if (perImage === null) return null;
    return perImage * images;
}

export interface ModelPricing {
    input: number;
    output: number;
    cachedInput: number;
}

/**
 * Resolves the $/1M token rates for a model (exact match, then prefix).
 * Exposed separately from calculateCost() so callers (e.g. Monitor) can record the
 * applied rates alongside the cost — OPENAI_PRICING is a mutable table and a future
 * price change must not alter an already computed historical cost.
 */
export function resolvePricing(model: string): ModelPricing | null {
    const pricing = OPENAI_PRICING[model];
    if (pricing) return pricing;

    const key = Object.keys(OPENAI_PRICING).find(k => model.startsWith(k));
    return key ? OPENAI_PRICING[key] : null;
}

export function calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens: number = 0
): number {
    const pricing = resolvePricing(model);
    if (!pricing) {
        console.warn(`[Cost] Pricing non disponibile per: ${model}`);
        return 0;
    }

    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const cachedCost = (cachedInputTokens / 1_000_000) * pricing.cachedInput;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;

    return inputCost + cachedCost + outputCost;
}
