/**
 * Monitor - Costs Logic
 */

// Prezzi per 1M token (OpenAI + Gemini)
const OPENAI_PRICING: Record<string, { input: number; output: number; cachedInput: number }> = {
    // OpenAI
    'gpt-5-nano': { input: 0.05, output: 0.40, cachedInput: 0.005 },
    'gpt-5-mini': { input: 0.25, output: 2.00, cachedInput: 0.025 },
    'gpt-5.2': { input: 1.75, output: 14.00, cachedInput: 0.175 }, // Flagship Model
    'gpt-5': { input: 1.25, output: 10.00, cachedInput: 0.125 },
    'text-embedding-3-small': { input: 0.020, output: 0, cachedInput: 0 },
    'text-embedding-3-large': { input: 0.130, output: 0, cachedInput: 0 },
    'gpt-4o-mini': { input: 0.15, output: 0.60, cachedInput: 0.075 },
    'gpt-4o': { input: 2.50, output: 10.00, cachedInput: 1.25 },
    // Gemini — prezzi ufficiali /1M token (tier a pagamento, prompt ≤200k token)
    // Fonte: https://ai.google.dev/gemini-api/docs/pricing
    'gemini-3.1-pro-preview': { input: 2.00,  output: 12.00, cachedInput: 0.20  },
    'gemini-3-pro-preview':   { input: 2.00,  output: 12.00, cachedInput: 0.20  },
    'gemini-3-flash-preview': { input: 0.50,  output: 3.00,  cachedInput: 0.05  },
    'gemini-2.5-pro':         { input: 1.25,  output: 10.00, cachedInput: 0.125 },
    'gemini-2.5-flash':       { input: 0.30,  output: 2.50,  cachedInput: 0.03  },
    'gemini-embedding-001':   { input: 0.15,  output: 0,     cachedInput: 0     },
    // Legacy
    'gemini-2.5-pro-preview': { input: 1.25,  output: 10.00, cachedInput: 0.125 },
    'gemini-2.0-flash':       { input: 0.10,  output: 0.40,  cachedInput: 0.025 },
};

export function calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens: number = 0
): number {
    const pricing = OPENAI_PRICING[model];
    if (!pricing) {
        const key = Object.keys(OPENAI_PRICING).find(k => model.startsWith(k));
        if (key) {
            const p = OPENAI_PRICING[key];
            const inputCost = (inputTokens / 1_000_000) * p.input;
            const cachedCost = (cachedInputTokens / 1_000_000) * p.cachedInput;
            const outputCost = (outputTokens / 1_000_000) * p.output;
            return inputCost + cachedCost + outputCost;
        }

        console.warn(`[Cost] Pricing non disponibile per: ${model}`);
        return 0;
    }

    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const cachedCost = (cachedInputTokens / 1_000_000) * pricing.cachedInput;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;

    return inputCost + cachedCost + outputCost;
}
