import { buildEuroCostSnapshot, type UsdEurRate } from '../services/aiCostTransparency';
import type { SessionMetrics } from './types';

/** Applies one immutable FX snapshot to a whole session cost breakdown. */
export function attachEuroCosts(
    costMetrics: NonNullable<SessionMetrics['costMetrics']>,
    exchangeRate: UsdEurRate,
): void {
    const totalSnapshot = buildEuroCostSnapshot(costMetrics.totalCostUSD, exchangeRate);
    costMetrics.totalCostEUR = totalSnapshot.costEur;
    costMetrics.usdPerEur = totalSnapshot.usdPerEur;
    costMetrics.exchangeRateSource = totalSnapshot.exchangeRateSource;
    costMetrics.exchangeRateDate = totalSnapshot.exchangeRateDate;
    costMetrics.exchangeRateFetchedAt = totalSnapshot.exchangeRateFetchedAt;

    for (const item of costMetrics.breakdown) {
        const snapshot = buildEuroCostSnapshot(item.costUSD, exchangeRate);
        item.costEUR = snapshot.costEur;
        item.usdPerEur = snapshot.usdPerEur;
        item.exchangeRateSource = snapshot.exchangeRateSource;
        item.exchangeRateDate = snapshot.exchangeRateDate;
        item.exchangeRateFetchedAt = snapshot.exchangeRateFetchedAt;
    }
}
