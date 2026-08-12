import {
    BadGatewayException,
    BadRequestException,
    HttpException,
} from '@nestjs/common';
import type { AIProvider } from '../../config';
import { classifyProviderError, redactKeyLike } from '../../bard/ai/providerErrors';
import { logger } from '../../utils/logger';

const log = logger('ProviderFailure');

/**
 * The HTTP answer a failed provider call deserves.
 *
 * Two paid actions — drawing a picture and analysing an appearance — had the
 * same catch block, and both of them turned everything that was not a refusal
 * into a bare 500. That is how a report reading «internal server error» came in
 * for what the logs showed to be Google answering *«This model is currently
 * experiencing high demand… please try again later»*: an upstream hiccup, on
 * somebody else's machine, presented to the table as a bug in this product.
 *
 * The distinction that matters to the person clicking is not the status code,
 * it is **what they should do next**:
 *
 *  - the request itself was wrong, or the key is dead, or the credit is gone —
 *    they have to change something, and the provider's own words say what;
 *  - the provider is busy or unreachable — they have to do nothing but wait,
 *    and telling them so is the whole answer;
 *  - anything else is genuinely ours, and the caller logs it and rethrows.
 *
 * Returns `null` for that third case rather than inventing an answer for it.
 *
 * The transient answer is **502**, not 503, and the difference is not pedantry:
 * 503 already means something else in these routes — «this instance has no
 * media storage configured», which is an operator's job and never heals by
 * clicking again. A single status covering both would leave the browser unable
 * to tell «wait a moment» from «this will never work».
 */
export function httpErrorForProviderFailure(
    provider: AIProvider,
    error: unknown,
    /** What was being attempted, in the user's terms: «generation», «analysis». */
    action: string,
): HttpException | null {
    const classified = classifyProviderError(provider, error);

    if (classified.kind === 'BAD_REQUEST' || classified.kind === 'AUTH_FAILED'
        || classified.kind === 'QUOTA_EXHAUSTED') {
        // The provider's own message, redacted: it names the model, the missing
        // parameter or the empty balance, which is exactly what the person needs
        // in order to fix it in their own settings.
        log.warn(`Provider refused the ${action}: ${redactKeyLike(classified.raw)}`);
        return new BadRequestException(redactKeyLike(classified.raw));
    }

    if (classified.kind === 'RATE_LIMITED') {
        log.warn(`${provider} rate-limited the ${action}`);
        return new BadGatewayException(
            `Too many requests to ${provider} right now — wait a few seconds and try again.`,
        );
    }

    if (classified.kind === 'UNREACHABLE') {
        /*
         * Deliberately not the provider's raw text here, unlike above. On this
         * path it is a JSON blob (`{"error":{"code":503,…}}`, which is how the
         * Google SDK carries a failed response) and it says nothing the person
         * can act on. What they need is that it was not their doing and that
         * clicking again is the fix.
         */
        log.warn(`${provider} was unreachable for the ${action}: ${redactKeyLike(classified.raw)}`);
        return new BadGatewayException(
            `The ${provider} model did not answer: it is momentarily overloaded or unreachable. `
            + 'Try again in a moment.',
        );
    }

    return null;
}
