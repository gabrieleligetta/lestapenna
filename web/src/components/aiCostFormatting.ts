/** Small AI costs need more decimals than money usually does to stay meaningful. */
function digitsFor(value: number): number {
    return value >= 1 ? 2 : value >= 0.01 ? 4 : 6;
}

function format(value: number, currency: 'EUR' | 'USD', locale: string, digits: number): string {
    return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    }).format(value);
}

export function formatAiMoney(
    value: number,
    currency: 'EUR' | 'USD',
    locale: string,
): string {
    return format(value, currency, locale, digitsFor(value));
}

/**
 * Both bounds share the precision the *smaller* one needs.
 *
 * Choosing digits per bound produced ranges like "€0.009000 – €0.0270", which
 * reads as two unrelated numbers; a range has to be comparable at a glance.
 */
export function formatAiMoneyRange(
    range: { min: number; max: number },
    currency: 'EUR' | 'USD',
    locale: string,
): string {
    const digits = Math.max(digitsFor(range.min), digitsFor(range.max));
    return `${format(range.min, currency, locale, digits)} – ${format(range.max, currency, locale, digits)}`;
}
