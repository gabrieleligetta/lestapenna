import type { AIProvider } from '../config';
import { isPaidCloudProvider } from '../bard/agent/runtime';
import { calculateCost, resolvePricing } from '../monitor/costs';
import {
    costUsdFor,
    hasKnownPrice,
    resolvePricingFor,
    type PricingSource,
} from './pricingSource';
import type { AiScope } from '../bard/ai/types';

const ECB_DAILY_RATES_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const ECB_FETCH_TIMEOUT_MS = 3_000;
const ECB_REFRESH_MS = 24 * 60 * 60 * 1000;
const ECB_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const ECB_RETRY_BACKOFF_MS = 5 * 60 * 1000;
const APPROX_CHARS_PER_TOKEN = 4;

export type FxSource = 'ECB' | 'STALE_ECB' | 'UNAVAILABLE';

export interface UsdEurRate {
    source: FxSource;
    /** USD quoted by ECB for one EUR. Convert USD→EUR by dividing by this value. */
    usdPerEur: number | null;
    rateDate: string | null;
    fetchedAt: number | null;
}

export interface TokenRange {
    inputMin: number;
    inputMax: number;
    outputMin: number;
    outputMax: number;
}

export interface MoneyRange {
    min: number;
    max: number;
}

export interface AgentCostEstimate {
    billable: boolean;
    pricingAvailable: boolean;
    tokens: TokenRange;
    costUsd: MoneyRange | null;
}

export interface ActualAiCost {
    billable: boolean;
    pricingAvailable: boolean;
    costUsd: number | null;
    inputPricePerMillion: number | null;
    outputPricePerMillion: number | null;
    cachedInputPricePerMillion: number | null;
    /**
     * Why that figure is that figure — or why there is none.
     *
     * It distinguishes «free», «included in the subscription» and «we do not know
     * the rate», which used to be all three zero.
     */
    pricingSource: PricingSource;
}

export interface EuroCostSnapshot {
    costEur: number | null;
    usdPerEur: number | null;
    exchangeRateSource: FxSource;
    exchangeRateDate: string | null;
    exchangeRateFetchedAt: number | null;
}

let cachedRate: (UsdEurRate & { fetchedAt: number }) | null = null;
let lastFetchAttempt = 0;

function parseEcbUsdRate(xml: string, fetchedAt: number): UsdEurRate & { fetchedAt: number } {
    const rateMatch = xml.match(/currency=["']USD["']\s+rate=["']([0-9.]+)["']/i);
    const dateMatch = xml.match(/time=["'](\d{4}-\d{2}-\d{2})["']/i);
    const usdPerEur = Number(rateMatch?.[1]);
    if (!Number.isFinite(usdPerEur) || usdPerEur <= 0 || !dateMatch?.[1]) {
        throw new Error('ECB response does not contain a valid USD reference rate');
    }
    return {
        source: 'ECB',
        usdPerEur,
        rateDate: dateMatch[1],
        fetchedAt,
    };
}

/**
 * Retrieves the official ECB daily EUR-base USD reference rate. The latest
 * successful value is retained in-process: a transient ECB outage must never
 * block an AI action. A rate older than seven days is not used for EUR display.
 */
export async function getUsdEurRate(now = Date.now()): Promise<UsdEurRate> {
    if (cachedRate && now - cachedRate.fetchedAt < ECB_REFRESH_MS) {
        return { ...cachedRate, source: 'ECB' };
    }

    const retrySuppressed = now - lastFetchAttempt < ECB_RETRY_BACKOFF_MS;
    if (!retrySuppressed) {
        lastFetchAttempt = now;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ECB_FETCH_TIMEOUT_MS);
        try {
            const response = await fetch(ECB_DAILY_RATES_URL, {
                headers: { accept: 'application/xml,text/xml;q=0.9' },
                signal: controller.signal,
            });
            if (!response.ok) throw new Error(`ECB HTTP ${response.status}`);
            cachedRate = parseEcbUsdRate(await response.text(), now);
            return { ...cachedRate, source: 'ECB' };
        } catch (error: any) {
            console.warn(`[AI Cost] ECB exchange-rate refresh failed: ${error?.message || String(error)}`);
        } finally {
            clearTimeout(timeout);
        }
    }

    if (cachedRate && now - cachedRate.fetchedAt <= ECB_MAX_STALE_MS) {
        return { ...cachedRate, source: 'STALE_ECB' };
    }
    return {
        source: 'UNAVAILABLE',
        usdPerEur: null,
        rateDate: null,
        fetchedAt: null,
    };
}

export function usdToEur(usd: number, rate: UsdEurRate): number | null {
    if (!rate.usdPerEur || rate.usdPerEur <= 0) return null;
    return usd / rate.usdPerEur;
}

/**
 * Freezes the EUR value and the exact exchange-rate metadata used for it.
 * A zero provider cost is zero in every currency even when ECB is unavailable;
 * a positive USD cost without a trustworthy rate remains NULL, never fake zero.
 */
/**
 * The rate when there is none.
 *
 * Not a zero and not a guess: `usdPerEur: null` is what makes every euro figure
 * downstream come out `null` too, which is the honest answer when the ECB could
 * not be reached. It lives here rather than in a controller because three of
 * them now need the same "we could not convert" answer.
 */
export const UNAVAILABLE_EXCHANGE_RATE: UsdEurRate = {
    source: 'UNAVAILABLE',
    usdPerEur: null,
    rateDate: null,
    fetchedAt: null,
};

export function buildEuroCostSnapshot(costUsd: number, rate: UsdEurRate): EuroCostSnapshot {
    return {
        costEur: costUsd === 0 ? 0 : usdToEur(costUsd, rate),
        usdPerEur: rate.usdPerEur,
        exchangeRateSource: rate.source,
        exchangeRateDate: rate.rateDate,
        exchangeRateFetchedAt: rate.fetchedAt,
    };
}

export function usdRangeToEur(range: MoneyRange | null, rate: UsdEurRate): MoneyRange | null {
    if (!range) return null;
    const min = usdToEur(range.min, rate);
    const max = usdToEur(range.max, rate);
    return min === null || max === null ? null : { min, max };
}

/**
 * Conservative local estimate for a bounded tool-calling agent. It makes no
 * provider request: prompt/tool character counts are converted with the usual
 * 4 chars/token approximation and expanded across the possible agent turns.
 */
export function estimateAgentCost(input: {
    provider: AIProvider;
    model: string;
    systemPromptChars: number;
    userPromptChars: number;
    toolSchemaChars: number;
    subjectCount: number;
    maxTurns: number;
    maxToolCalls: number;
    maxToolResultChars: number;
}): AgentCostEstimate {
    const baseTokens = Math.ceil(
        (input.systemPromptChars + input.userPromptChars + input.toolSchemaChars) /
        APPROX_CHARS_PER_TOKEN,
    );
    const maxToolTokens = Math.ceil(
        (input.maxToolCalls * input.maxToolResultChars) / APPROX_CHARS_PER_TOKEN,
    );
    const inputMin = Math.max(1, baseTokens * 2);
    const inputMax = Math.max(
        inputMin,
        Math.ceil(input.maxTurns * (baseTokens + maxToolTokens) * 1.15),
    );
    const outputMin = Math.max(300, 200 + input.subjectCount * 80);
    const outputMax = Math.min(
        16_384,
        Math.max(1_000, 600 + input.subjectCount * 250),
    );
    const tokens = { inputMin, inputMax, outputMin, outputMax };
    const billable = isPaidCloudProvider(input.provider);
    if (!billable) {
        return {
            billable: false,
            pricingAvailable: true,
            tokens,
            costUsd: { min: 0, max: 0 },
        };
    }

    const pricing = resolvePricing(input.model);
    if (!pricing) {
        return { billable: true, pricingAvailable: false, tokens, costUsd: null };
    }
    return {
        billable: true,
        pricingAvailable: true,
        tokens,
        costUsd: {
            min: calculateCost(input.model, inputMin, outputMin),
            max: calculateCost(input.model, inputMax, outputMax),
        },
    };
}

/**
 * The final tally of a call.
 *
 * `costUsd` is `null` when it cannot be stated, and **not zero**: answering «zero»
 * to «I do not know» is the only way this layer can lie about somebody else's
 * money. The `scope` is there to honour the rates the table has declared for
 * itself.
 */
export function calculateActualAiCost(
    provider: AIProvider,
    model: string,
    usage: { input: number; output: number; cached?: number },
    scope?: AiScope,
): ActualAiCost {
    const resolved = resolvePricingFor(provider, model, scope);

    return {
        // "Billable" means this call can appear on a user's invoice:
        // a flat plan does not, an unknown price perhaps does.
        billable: resolved.source !== 'free' && resolved.source !== 'subscription',
        pricingAvailable: hasKnownPrice(resolved.source),
        costUsd: costUsdFor(resolved, usage),
        inputPricePerMillion: resolved.pricing?.input ?? null,
        outputPricePerMillion: resolved.pricing?.output ?? null,
        cachedInputPricePerMillion: resolved.pricing?.cachedInput ?? null,
        pricingSource: resolved.source,
    };
}

/** Test-only reset for deterministic cache/fallback coverage. */
export function resetUsdEurRateCache(): void {
    cachedRate = null;
    lastFetchAttempt = 0;
}
