/**
 * Shared classification of retryable network/API errors.
 * It used to be duplicated byte-for-byte in geminiNativeGenerate.ts and
 * anthropicNativeGenerate.ts: this is the single source of truth.
 */

import { classifyProviderError } from '../ai/providerErrors';

/**
 * Exhausted credit or an invalid credential: retrying is wasted time.
 *
 * The provider is not known here — the function is shared by every path — but
 * the classification works on codes and messages, not on the provider, so a
 * placeholder is fine for the sole purpose of deciding whether to retry.
 */
function isCreditOrAuthFailure(error: unknown): boolean {
    const { kind } = classifyProviderError('openai', error);
    return kind === 'QUOTA_EXHAUSTED' || kind === 'AUTH_FAILED';
}

export const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND'
]);

/**
 * True for transient errors worth retrying: 429/5xx, network/socket faults
 * (undici's fetch has no numeric HTTP status: e.g. `TypeError: fetch failed`
 * with cause `UND_ERR_SOCKET` / "other side closed").
 *
 * ⚠️ A 429 is not automatically transient: OpenAI uses it **also** for an
 * exhausted quota (`insufficient_quota`), which will never heal on its own.
 * Retrying it only burns the user's time before failing anyway, so the
 * per-provider classification takes precedence.
 */
export function isRetryableNetworkError(error: any): boolean {
    if (isCreditOrAuthFailure(error)) return false;

    const status = error?.status || error?.code;
    if (status === 429 || (typeof status === 'number' && status >= 500)) return true;

    const causeCode = error?.cause?.code || (typeof error?.code === 'string' ? error.code : undefined);
    if (typeof causeCode === 'string' && RETRYABLE_NETWORK_CODES.has(causeCode)) return true;

    const msg = `${error?.message || ''} ${error?.cause?.message || ''}`.toLowerCase();
    return msg.includes('fetch failed') || msg.includes('other side closed') ||
        msg.includes('terminated') || msg.includes('socket hang up') || msg.includes('network');
}
