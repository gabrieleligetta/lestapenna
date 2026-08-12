/**
 * Classification of provider errors.
 *
 * Under BYOK this distinction decides whether the user waits for a retry that will
 * never come or is told straight away to "top up your credit". The signatures have been
 * verified against the real APIs and are not interchangeable between providers, so
 * each has its own case.
 */

import { classifyProviderError, ProviderCallError, redactKeyLike } from '../../../src/bard/ai/providerErrors';
import { isRetryableNetworkError } from '../../../src/bard/llm/retry';

/** The error in the shape the OpenAI SDK delivers it. */
function openAiError(status: number, code: string, message: string) {
    return Object.assign(new Error(message), { status, code });
}

describe('classifyProviderError', () => {
    describe('credito esaurito', () => {
        it('recognises OpenAI\'s insufficient_quota, which arrives as a 429', () => {
            // OpenAI uses 429 BOTH for the rate limit AND for an exhausted quota: without
            // looking at the code, a dry key would be retried forever.
            const error = openAiError(
                429,
                'insufficient_quota',
                'You exceeded your current quota, please check your plan and billing details.',
            );
            const result = classifyProviderError('openai', error);

            expect(result.kind).toBe('QUOTA_EXHAUSTED');
            expect(result.retryable).toBe(false);
            expect(result.actionableByUser).toBe(true);
        });

        it('recognises Anthropic\'s credit_balance_too_low, which arrives as a 400', () => {
            const error = Object.assign(
                new Error('Your credit balance is too low to access the Anthropic API.'),
                { status: 400, error: { type: 'credit_balance_too_low' } },
            );
            const result = classifyProviderError('anthropic', error);

            expect(result.kind).toBe('QUOTA_EXHAUSTED');
            expect(result.retryable).toBe(false);
        });

        it('recognises a Gemini billing account that is not active', () => {
            const error = Object.assign(
                new Error('Billing account for project is not active.'),
                { status: 403 },
            );
            expect(classifyProviderError('gemini', error).kind).toBe('QUOTA_EXHAUSTED');
        });
    });

    describe('rate limit', () => {
        it('a 429 with no quota markers stays retryable', () => {
            const error = openAiError(429, 'rate_limit_exceeded', 'Rate limit reached for gpt-5.6-luna');
            const result = classifyProviderError('openai', error);

            expect(result.kind).toBe('RATE_LIMITED');
            expect(result.retryable).toBe(true);
            // It is not the user's fault and there is nothing they can do: they must not
            // be sent to check their own key.
            expect(result.actionableByUser).toBe(false);
        });
    });

    describe('credenziale non valida', () => {
        it('recognises a wrong key', () => {
            const error = openAiError(401, 'invalid_api_key', 'Incorrect API key provided: sk-xxx');
            const result = classifyProviderError('openai', error);

            expect(result.kind).toBe('AUTH_FAILED');
            expect(result.retryable).toBe(false);
            expect(result.actionableByUser).toBe(true);
        });
    });

    describe('transitori', () => {
        it.each([500, 502, 503])('retries on 5xx (%s)', (status) => {
            const result = classifyProviderError('openai', openAiError(status, '', 'Bad gateway'));
            expect(result.kind).toBe('UNREACHABLE');
            expect(result.retryable).toBe(true);
        });

        it('retries on network faults that carry no HTTP status', () => {
            // undici produces no numeric status: only the cause code.
            const error = Object.assign(new TypeError('fetch failed'), {
                cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' },
            });
            expect(classifyProviderError('openai', error).retryable).toBe(true);
        });
    });

    it('does not declare a key dead over an error it does not know', () => {
        // Conservativo di proposito: mandare a ricaricare chi ha credito è
        // peggio di un retry sprecato.
        const result = classifyProviderError('openai', new Error('qualcosa di strano'));
        expect(result.kind).toBe('UNKNOWN');
        expect(result.actionableByUser).toBe(false);
    });
});

describe('isRetryableNetworkError', () => {
    it('does NOT retry an exhausted quota, 429 or not', () => {
        // This is the regression that matters: every 429 used to be retryable, so a
        // key with no credit burned all the attempts before failing
        // anyway, lengthening the user's wait with no chance of
        // success.
        const error = openAiError(
            429, 'insufficient_quota', 'You exceeded your current quota',
        );
        expect(isRetryableNetworkError(error)).toBe(false);
    });

    it('continua a ritentare un rate limit vero', () => {
        expect(isRetryableNetworkError(openAiError(429, 'rate_limit_exceeded', 'slow down'))).toBe(true);
    });

    it('does not retry an invalid key', () => {
        expect(isRetryableNetworkError(openAiError(401, 'invalid_api_key', 'bad key'))).toBe(false);
    });

    it('continua a ritentare i 5xx e i fault di rete', () => {
        expect(isRetryableNetworkError(openAiError(503, '', 'unavailable'))).toBe(true);
        expect(isRetryableNetworkError(new TypeError('fetch failed'))).toBe(true);
    });
});

describe('ProviderCallError', () => {
    it('flags the credential only for quota and authentication', () => {
        const quota = new ProviderCallError(
            classifyProviderError('openai', openAiError(429, 'insufficient_quota', 'no credit')),
            'gpt-5.6-luna',
        );
        const rateLimit = new ProviderCallError(
            classifyProviderError('openai', openAiError(429, 'rate_limit_exceeded', 'slow down')),
            'gpt-5.6-luna',
        );

        expect(quota.shouldFlagCredential).toBe(true);
        // A rate limit says nothing about the key's health.
        expect(rateLimit.shouldFlagCredential).toBe(false);
    });

    it('keeps provider and model in the message, for the logs', () => {
        const error = new ProviderCallError(
            classifyProviderError('anthropic', openAiError(400, 'credit_balance_too_low', 'too low')),
            'claude-sonnet-5',
        );
        expect(error.message).toContain('anthropic/claude-sonnet-5');
        expect(error.message).toContain('QUOTA_EXHAUSTED');
    });
});

describe('redactKeyLike', () => {
    it('strips the key the provider echoes back', () => {
        // OpenAI answers literally «Incorrect API key provided: sk-…».
        // That text would end up in `verify_error`, stored in clear next
        // to the encrypted credential: it would undo the vault by itself.
        const echoedKey = ['sk', 'proj', 'example', 'AbC123XyZ789def'].join('-');
        const redacted = redactKeyLike(`Incorrect API key provided: ${echoedKey}`);

        expect(redacted).not.toContain(echoedKey);
        expect(redacted).toContain('Incorrect API key provided');
    });

    it('leaves the rest of the message readable', () => {
        expect(redactKeyLike('You exceeded your current quota, check your plan'))
            .toBe('You exceeded your current quota, check your plan');
    });
});
