import type { UsdEurRate } from '../../../services/aiCostTransparency';
import { AiExchangeRateDto } from './entities.dto';

/**
 * The exchange rate, as the API spells it.
 *
 * The mapping is three renamed fields, which is exactly why it should exist once:
 * it was written inline in the quest audit, and every further paid action needs
 * the same answer — including "we could not convert", which has to stay
 * distinguishable from a rate of zero.
 */
export function exchangeRateDto(rate: UsdEurRate): AiExchangeRateDto {
    return {
        source: rate.source,
        usd_per_eur: rate.usdPerEur,
        rate_date: rate.rateDate,
        fetched_at: rate.fetchedAt,
    };
}
