import type { AIProvider } from '../config';
import { resolvePricing, type ModelPricing } from '../monitor/costs';
import { catalogPricing, imagePricePerImage } from '../bard/ai/modelCatalog';
import { tenantAiSettingsRepository } from '../db/repositories/TenantAiSettingsRepository';
import type { TenantAiSettings } from '../bard/ai/resolver';
import type { AiScope } from '../bard/ai/types';

/**
 * Where the price we show comes from, and whether it is a price at all.
 *
 * Until yesterday there were only two outcomes: a figure, or zero. And zero
 * meant three different and incompatible things:
 *
 *  - **genuinely free** — it runs on the table's own hardware;
 *  - **included in a subscription** — Ollama Cloud bills GPU-time on a flat
 *    plan, with per-session and weekly limits: one more call does not add to any
 *    bill, but it can move you closer to a cap;
 *  - **we do not know** — a model released last week, or typed in by hand by
 *    the user.
 *
 * Showing €0 for the third case is the worst lie: the user is paying and reads
 * that they are not. Hence `pricing_source`, which accompanies every row of
 * `ai_usage_log` and every estimate, so a missing figure stays missing instead of
 * becoming zero.
 */

export type PricingSource =
    /**
     * Rate from our price list — the refreshed catalogue first, the table
     * committed in `monitor/costs.ts` when it has nothing on that model.
     *
     * The two are the same claim («this is the published rate we know»), so
     * they share one value: which of them answered is an implementation detail,
     * and splitting it would put a distinction nobody can act on into a column
     * already written on thousands of rows.
     */
    | 'builtin'
    /** A rate declared by the table: enterprise discount, Batch API, contract. */
    | 'tenant_override'
    /** Runs on the table's own hardware: zero is the truth. */
    | 'free'
    /** Flat plan: the marginal cost is zero, but there is a quota being spent. */
    | 'subscription'
    /** Non conosciamo la tariffa. **Non** è zero. */
    | 'unknown';

export interface ResolvedPricing {
    source: PricingSource;
    /** `null` when it cannot be stated: `unknown`, and `subscription` for the euro figure. */
    pricing: ModelPricing | null;
    /**
     * USD per generated picture, when the table has declared one.
     *
     * Only ever set by a `tenant_override`: every other source answers through
     * the catalogue, which `imageCostUsdFor` consults on its own.
     */
    perImageUsd?: number | null;
}

/** Rates declared by the table, by exact model or by prefix. */
export interface TenantPricingOverride {
    /** The model's id, or a prefix when it ends with `*`. */
    model: string;
    inputPerMillion: number;
    outputPerMillion: number;
    cachedInputPerMillion?: number;
    /**
     * USD per generated picture, for image models.
     *
     * Without it the escape hatch does not reach the one action where it matters
     * most: an image model is billed per picture, so a table facing an `unknown`
     * price on a portrait had no way at all to make it known — the two per-token
     * fields describe a unit that model never consumes.
     */
    perImageUsd?: number;
}

/** Providers that bill on a flat plan rather than per use. */
const SUBSCRIPTION_PROVIDERS: AIProvider[] = ['ollama-cloud'];

/** Providers that run on the hardware of whoever uses them. */
const LOCAL_PROVIDERS: AIProvider[] = ['ollama'];

function overridesFor(scope: AiScope | undefined): TenantPricingOverride[] {
    if (!scope) return [];
    const settings = tenantAiSettingsRepository
        .get<TenantAiSettings>('guild', scope.guildId)?.settings;
    return settings?.pricingOverrides ?? [];
}

function matchOverride(
    overrides: TenantPricingOverride[],
    model: string,
): TenantPricingOverride | undefined {
    // Exact match before the prefix: someone who declares both `gpt-5*` and
    // `gpt-5.6-sol` means the second one to be more specific.
    return overrides.find(o => o.model === model)
        ?? overrides.find(o => o.model.endsWith('*') && model.startsWith(o.model.slice(0, -1)));
}

/**
 * Resolves a model's rate, saying where it comes from.
 *
 * The table's override wins **even over the models we know**: anyone with an
 * enterprise discount or using the Batch API really does pay different rates, and
 * imposing our price list on them would be a lie about their own invoice.
 */
export function resolvePricingFor(
    provider: AIProvider,
    model: string,
    scope?: AiScope,
): ResolvedPricing {
    const override = matchOverride(overridesFor(scope), model);
    if (override) {
        return {
            source: 'tenant_override',
            pricing: {
                input: override.inputPerMillion,
                output: override.outputPerMillion,
                cachedInput: override.cachedInputPerMillion ?? 0,
            },
            perImageUsd: override.perImageUsd ?? null,
        };
    }

    if (LOCAL_PROVIDERS.includes(provider)) {
        return { source: 'free', pricing: { input: 0, output: 0, cachedInput: 0 } };
    }

    if (SUBSCRIPTION_PROVIDERS.includes(provider)) {
        // No euro figure derived from the tokens: that plan does not measure tokens but
        // GPU-time, and amortizing the subscription would produce a figure matching
        // no transaction at all. Usage is told in tokens, which stay true
        // information.
        return { source: 'subscription', pricing: null };
    }

    // The catalogue first: it knows models released after the committed table
    // was last edited, which is precisely the case where that table answers
    // `unknown` for something whose price is perfectly public.
    const listed = catalogPricing(model) ?? resolvePricing(model);
    if (listed) return { source: 'builtin', pricing: listed };

    /*
     * An image model has no per-token rate to find, and that is not the same as
     * having an unknown one.
     *
     * Without this the two halves of the answer contradicted each other: the
     * cost came out right, because `imageCostUsdFor` consults the per-picture
     * list, while the source said `unknown` — so a perfectly known $0.04 was
     * being filed in `ai_usage_log` as a spend at a rate nobody knew. `pricing`
     * stays null because there genuinely is no per-token figure; the per-picture
     * one travels in its own field.
     */
    const perImage = imagePricePerImage(model);
    if (perImage !== null) return { source: 'builtin', pricing: null, perImageUsd: perImage };

    return { source: 'unknown', pricing: null };
}

/**
 * Cost in USD, or `null` when it cannot be stated.
 *
 * `null` and `0` are different answers and have to stay different all the way to
 * the UI: `calculateCost` returned zero for an unknown model, that is, it answered
 * «free» to «I do not know».
 */
export function costUsdFor(
    resolved: ResolvedPricing,
    usage: { input: number; output: number; cached?: number },
): number | null {
    if (!resolved.pricing) return null;
    const { input, output, cachedInput } = resolved.pricing;
    return (usage.input / 1_000_000) * input
        + (usage.output / 1_000_000) * output
        + ((usage.cached ?? 0) / 1_000_000) * cachedInput;
}

/**
 * Cost of generating pictures, in USD, or `null` when it cannot be stated.
 *
 * Separate from `costUsdFor` because the unit is: an image model consumes no
 * tokens to speak of, and running its cost through the per-token path would
 * report a few thousandths of a cent for something that costs four cents.
 *
 * The table's declared rate wins over the catalogue here as it does everywhere
 * else — and on the most expensive action in the product it is also the only way
 * an `unknown` can ever become known.
 */
export function imageCostUsdFor(
    resolved: ResolvedPricing,
    model: string,
    images: number,
): number | null {
    const perImage = resolved.perImageUsd ?? imagePricePerImage(model);
    if (perImage === null) return null;
    return perImage * images;
}

/** True when the figure shown is a figure and not an absence. */
export function hasKnownPrice(source: PricingSource): boolean {
    return source === 'builtin' || source === 'tenant_override' || source === 'free';
}
