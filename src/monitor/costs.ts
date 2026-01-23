/**
 * Monitor - Costs Logic
 */

// Prezzi OpenAI (per 1M token)
const OPENAI_PRICING: Record<string, { input: number; output: number; cachedInput: number }> = {
    'gpt-5-nano': { input: 0.05, output: 0.40, cachedInput: 0.005 },
    'gpt-5-mini': { input: 0.25, output: 2.00, cachedInput: 0.025 },
    'gpt-5.2': { input: 1.75, output: 14.00, cachedInput: 0.175 }, // Flagship Model
    'gpt-5': { input: 1.25, output: 10.00, cachedInput: 0.125 },
    'text-embedding-3-small': { input: 0.020, output: 0, cachedInput: 0 },
    'text-embedding-3-large': { input: 0.130, output: 0, cachedInput: 0 },
    // Fallback for older models or aliases if needed
    'gpt-4o-mini': { input: 0.15, output: 0.60, cachedInput: 0.075 },
    'gpt-4o': { input: 2.50, output: 10.00, cachedInput: 1.25 },
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
