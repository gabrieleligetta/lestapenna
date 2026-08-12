/**
 * Where the price comes from, and when there is none.
 *
 * Until yesterday «free», «included in the subscription» and «we do not know» were
 * the same figure: zero. The third case is the one that matters — a user who is
 * paying and reads that they are not. Every case here defends that distinction.
 */

import { wipeDatabase } from '../../../src/db/maintenance';
import { tenantAiSettingsRepository } from '../../../src/db/repositories/TenantAiSettingsRepository';
import {
    costUsdFor,
    hasKnownPrice,
    imageCostUsdFor,
    resolvePricingFor,
} from '../../../src/services/pricingSource';
import { calculateActualAiCost } from '../../../src/services/aiCostTransparency';

const GUILD = 'gilda-prezzi';

beforeEach(() => wipeDatabase());

describe('where the price comes from', () => {
    it('a catalogue model comes from the catalogue', () => {
        const resolved = resolvePricingFor('openai', 'gpt-5.6-terra');
        expect(resolved.source).toBe('builtin');
        expect(resolved.pricing?.input).toBeGreaterThan(0);
    });

    it('Ollama locale è gratis davvero, e zero è la verità', () => {
        const resolved = resolvePricingFor('ollama', 'qwen3:14b');
        expect(resolved.source).toBe('free');
        expect(costUsdFor(resolved, { input: 1_000_000, output: 500_000 })).toBe(0);
    });

    it('un piano fisso non produce un euro derivato dai token', () => {
        // Ollama Cloud bills GPU-time on a flat plan, with per-session
        // and weekly limits: there is no token cap from which to derive a
        // fraction, and amortizing the subscription would give a figure matching
        // no transaction at all.
        const resolved = resolvePricingFor('ollama-cloud', 'glm-5.2:cloud');
        expect(resolved.source).toBe('subscription');
        expect(costUsdFor(resolved, { input: 1_000_000, output: 500_000 })).toBeNull();
    });

    it('a model we do not know does NOT cost zero', () => {
        // It is the lie this module exists to prevent: answering «free»
        // to «I do not know» while the user is paying.
        const resolved = resolvePricingFor('openai', 'gpt-uscito-domani');
        expect(resolved.source).toBe('unknown');
        expect(costUsdFor(resolved, { input: 1_000_000, output: 500_000 })).toBeNull();
    });

    it('tells a figure apart from an absence', () => {
        expect(hasKnownPrice('builtin')).toBe(true);
        expect(hasKnownPrice('free')).toBe(true);
        expect(hasKnownPrice('subscription')).toBe(false);
        expect(hasKnownPrice('unknown')).toBe(false);
    });
});

describe('rates declared by the table', () => {
    it('they win even over a model we do know', () => {
        // Anyone with an enterprise discount or using the Batch API really does pay something else:
        // imposing our price list on them would be a lie about their own invoice.
        tenantAiSettingsRepository.put('guild', GUILD, {
            pricingOverrides: [{ model: 'gpt-5.6-terra', inputPerMillion: 0.5, outputPerMillion: 3 }],
        });

        const resolved = resolvePricingFor('openai', 'gpt-5.6-terra', { guildId: GUILD });
        expect(resolved.source).toBe('tenant_override');
        expect(resolved.pricing?.input).toBe(0.5);
    });

    it('they give a price to a model that was not in the table', () => {
        tenantAiSettingsRepository.put('guild', GUILD, {
            pricingOverrides: [{ model: 'un-modello-mio', inputPerMillion: 1, outputPerMillion: 2 }],
        });

        const resolved = resolvePricingFor('openai', 'un-modello-mio', { guildId: GUILD });
        expect(resolved.source).toBe('tenant_override');
        expect(costUsdFor(resolved, { input: 1_000_000, output: 1_000_000 })).toBe(3);
    });

    it('they accept a prefix, and an exact match is more specific', () => {
        tenantAiSettingsRepository.put('guild', GUILD, {
            pricingOverrides: [
                { model: 'gpt-5*', inputPerMillion: 10, outputPerMillion: 10 },
                { model: 'gpt-5.6-luna', inputPerMillion: 1, outputPerMillion: 1 },
            ],
        });

        expect(resolvePricingFor('openai', 'gpt-5.6-sol', { guildId: GUILD }).pricing?.input).toBe(10);
        expect(resolvePricingFor('openai', 'gpt-5.6-luna', { guildId: GUILD }).pricing?.input).toBe(1);
    });

    it('they apply only to the guild that declared them', () => {
        tenantAiSettingsRepository.put('guild', GUILD, {
            pricingOverrides: [{ model: 'gpt-5.6-terra', inputPerMillion: 0.5, outputPerMillion: 3 }],
        });

        expect(resolvePricingFor('openai', 'gpt-5.6-terra', { guildId: 'altra-gilda' }).source)
            .toBe('builtin');
    });
});

describe('the final figure for one call', () => {
    it('does not declare zero when it does not know the rate', () => {
        const cost = calculateActualAiCost('openai', 'gpt-mai-visto', { input: 1000, output: 500 });

        expect(cost.pricingSource).toBe('unknown');
        expect(cost.costUsd).toBeNull();
        expect(cost.pricingAvailable).toBe(false);
    });

    it('on the table\'s own hardware it declares zero, and says so', () => {
        const cost = calculateActualAiCost('ollama', 'qwen3:14b', { input: 1000, output: 500 });

        expect(cost.pricingSource).toBe('free');
        expect(cost.costUsd).toBe(0);
        expect(cost.billable).toBe(false);
    });

    it('su un piano fisso non è fatturabile e non ha un euro', () => {
        const cost = calculateActualAiCost('ollama-cloud', 'glm-5.2:cloud', { input: 1000, output: 500 });

        expect(cost.pricingSource).toBe('subscription');
        expect(cost.billable).toBe(false);
        expect(cost.costUsd).toBeNull();
    });

    it('honours the table\'s rates in the final figure, not just the estimate', () => {
        tenantAiSettingsRepository.put('guild', GUILD, {
            pricingOverrides: [{ model: 'gpt-5.6-terra', inputPerMillion: 1, outputPerMillion: 0 }],
        });

        const cost = calculateActualAiCost(
            'openai', 'gpt-5.6-terra', { input: 1_000_000, output: 0 }, { guildId: GUILD },
        );
        expect(cost.costUsd).toBe(1);
        expect(cost.pricingSource).toBe('tenant_override');
    });
});

/**
 * Images are billed per picture, a third unit next to per-token and per-minute.
 *
 * They are also the most expensive single click in the product, which is why
 * "we do not know" must survive all the way here: rounding an unknown down to
 * zero is worst exactly where the number is biggest.
 */
describe('what one generated picture costs', () => {
    it('prices a known image model per picture, not per token', () => {
        const resolved = resolvePricingFor('gemini', 'imagen-4.0-generate-001');
        expect(imageCostUsdFor(resolved, 'imagen-4.0-generate-001', 1)).toBeCloseTo(0.04, 4);
    });

    it('multiplies by the number of pictures', () => {
        const resolved = resolvePricingFor('openai', 'gpt-image-1-mini');
        expect(imageCostUsdFor(resolved, 'gpt-image-1-mini', 3)).toBeCloseTo(0.024, 4);
    });

    it('answers null, not zero, for a model whose rate we do not know', () => {
        const resolved = resolvePricingFor('openai', 'some-brand-new-image-model');
        expect(imageCostUsdFor(resolved, 'some-brand-new-image-model', 1)).toBeNull();
    });

    it('lets the table declare a per-picture rate, which wins over ours', () => {
        // Without this the escape hatch never reached image models at all: the
        // two per-token fields describe a unit they do not consume.
        tenantAiSettingsRepository.put('guild', GUILD, {
            pricingOverrides: [{
                model: 'imagen-4.0-generate-001',
                inputPerMillion: 0,
                outputPerMillion: 0,
                perImageUsd: 0.01,
            }],
        });

        const resolved = resolvePricingFor(
            'gemini', 'imagen-4.0-generate-001', { guildId: GUILD },
        );
        expect(resolved.source).toBe('tenant_override');
        expect(imageCostUsdFor(resolved, 'imagen-4.0-generate-001', 2)).toBeCloseTo(0.02, 4);
    });

    it('turns an unknown rate into a known one when the table declares it', () => {
        tenantAiSettingsRepository.put('guild', GUILD, {
            pricingOverrides: [{
                model: 'some-brand-new-image-model',
                inputPerMillion: 0,
                outputPerMillion: 0,
                perImageUsd: 0.07,
            }],
        });

        const resolved = resolvePricingFor(
            'openai', 'some-brand-new-image-model', { guildId: GUILD },
        );
        expect(imageCostUsdFor(resolved, 'some-brand-new-image-model', 1)).toBeCloseTo(0.07, 4);
    });
});
