import type { AIProvider } from '../../config';

/**
 * Classification of AI provider errors.
 *
 * Under BYOK the difference between "slow down" and "you have run out of
 * credit" is not a nuance: it is the difference between retrying in ten seconds
 * and retrying forever for nothing. `isRetryableNetworkError` treats every 429
 * as transient, which is right for a rate limit and wrong for an exhausted
 * quota — which will never heal on its own, and on which the only useful action
 * is telling the user.
 *
 * The signatures differ per provider and are not interchangeable:
 *  - OpenAI uses **429** for both the rate limit and the exhausted quota, and
 *    distinguishes them only with `code: 'insufficient_quota'`;
 *  - Anthropic uses **400** with type `credit_balance_too_low`, which however
 *    also covers "the model requires a higher tier": the message to the user
 *    has to stay honest about that ambiguity;
 *  - Gemini uses 429 `RESOURCE_EXHAUSTED` for the rate limit and 403 with
 *    billing references when the account is not a paying one.
 */

export type ProviderErrorKind =
    /** Key missing, revoked or malformed. Retrying is pointless. */
    | 'AUTH_FAILED'
    /** Out of credit, or the plan is not enabled. Retrying will not help. */
    | 'QUOTA_EXHAUSTED'
    /** Troppe richieste al minuto: ritentare ha senso. */
    | 'RATE_LIMITED'
    /** Rete, socket, 5xx: transitorio. */
    | 'UNREACHABLE'
    /** Richiesta non valida (prompt troppo lungo, parametro errato). */
    | 'BAD_REQUEST'
    | 'UNKNOWN';

export interface ClassifiedProviderError {
    kind: ProviderErrorKind;
    /** False for AUTH_FAILED, QUOTA_EXHAUSTED and BAD_REQUEST: retrying is wasted time. */
    retryable: boolean;
    /** True when the user has to act on their own credentials or their own credit. */
    actionableByUser: boolean;
    provider: AIProvider;
    status: number | null;
    /** The original message, useful in the logs; it must not be shown raw to the user. */
    raw: string;
}

function statusOf(error: any): number | null {
    const status = error?.status ?? error?.statusCode ?? error?.response?.status;
    return typeof status === 'number' ? status : null;
}

function messageOf(error: any): string {
    return [
        error?.message,
        error?.error?.message,
        error?.response?.data?.error?.message,
        error?.cause?.message,
    ].filter(Boolean).join(' ');
}

function codeOf(error: any): string {
    return String(
        error?.code
        ?? error?.error?.code
        ?? error?.error?.type
        ?? error?.type
        ?? error?.response?.data?.error?.code
        ?? '',
    ).toLowerCase();
}

/**
 * Out-of-credit signals common to several providers.
 *
 * Deliberately conservative: declaring a live key "dead" is worse than a
 * pointless retry, because it blocks the table and sends it off to top up
 * credit it already has.
 */
const QUOTA_MARKERS = [
    'insufficient_quota',
    'credit_balance_too_low',
    'credit balance is too low',
    'exceeded your current quota',
    'billing_not_active',
    'billing account',
    'insufficient credits',
    'quota exceeded for quota metric',
    'plan and billing',
];

const AUTH_MARKERS = [
    'invalid_api_key',
    'invalid api key',
    'incorrect api key',
    'authentication_error',
    'api key not valid',
    'permission_denied',
    'unauthorized',
];

function includesAny(haystack: string, needles: string[]): boolean {
    return needles.some(n => haystack.includes(n));
}

export function classifyProviderError(provider: AIProvider, error: unknown): ClassifiedProviderError {
    const status = statusOf(error);
    const raw = messageOf(error);
    const haystack = `${codeOf(error)} ${raw}`.toLowerCase();

    const base = { provider, status, raw };

    // The quota has to be assessed BEFORE the status: OpenAI hides it inside a 429
    // identical to the rate limit one, and Anthropic inside a 400.
    if (includesAny(haystack, QUOTA_MARKERS)) {
        return { ...base, kind: 'QUOTA_EXHAUSTED', retryable: false, actionableByUser: true };
    }

    if (status === 401 || status === 403 || includesAny(haystack, AUTH_MARKERS)) {
        return { ...base, kind: 'AUTH_FAILED', retryable: false, actionableByUser: true };
    }

    if (status === 429) {
        // A 429 that made it this far carries no quota markers: it is a real
        // rate limit, and retrying is the right thing to do.
        return { ...base, kind: 'RATE_LIMITED', retryable: true, actionableByUser: false };
    }

    if (status !== null && status >= 500) {
        return { ...base, kind: 'UNREACHABLE', retryable: true, actionableByUser: false };
    }

    const causeCode = String(error && typeof error === 'object' && 'cause' in error
        ? (error as any).cause?.code ?? ''
        : '');
    const networkish = /fetch failed|other side closed|terminated|socket hang up|network|econnreset|econnrefused|etimedout|enotfound/i;
    if (networkish.test(haystack) || networkish.test(causeCode)) {
        return { ...base, kind: 'UNREACHABLE', retryable: true, actionableByUser: false };
    }

    if (status === 400 || status === 404 || status === 422) {
        return { ...base, kind: 'BAD_REQUEST', retryable: false, actionableByUser: false };
    }

    return { ...base, kind: 'UNKNOWN', retryable: false, actionableByUser: false };
}

/**
 * Typed error that travels up to the Discord commands and to the API.
 *
 * It exists so the user is not shown a raw provider message — which depending on
 * the day talks about "quota", "billing details" or "credit balance" — but a
 * sentence that says what happened on *their* account and what they can do about
 * it.
 */
export class ProviderCallError extends Error {
    /** The provider's original error, for the logs. `Error.cause` is not in the target lib. */
    readonly originalError?: unknown;

    constructor(
        readonly classification: ClassifiedProviderError,
        readonly model: string,
        originalError?: unknown,
    ) {
        super(`[${classification.provider}/${model}] ${classification.kind}: ${classification.raw}`);
        this.name = 'ProviderCallError';
        this.originalError = originalError;
    }

    get kind(): ProviderErrorKind {
        return this.classification.kind;
    }

    /** True when it makes sense to flag the credential as needing review. */
    get shouldFlagCredential(): boolean {
        return this.classification.kind === 'QUOTA_EXHAUSTED'
            || this.classification.kind === 'AUTH_FAILED';
    }
}

/**
 * Strips from an error message anything that looks like a key.
 *
 * It is needed because providers **send the key back**: OpenAI answers
 * «Incorrect API key provided: sk-abc…». That text ends up in the `verify_error`
 * stored in clear next to the encrypted credential, and from there in the UI —
 * that is, it would undo the whole vault by itself.
 *
 * The criterion is deliberately coarse — long sequences of letters and digits —
 * because it is better to redact one request id too many than to let a key
 * through. The message is there to understand *what* went wrong, not to read
 * identifiers.
 */
export function redactKeyLike(text: string): string {
    return text.replace(/[A-Za-z0-9_\-]{16,}/g, match =>
        /[A-Za-z]/.test(match) && /[0-9]/.test(match) ? '***' : match);
}

/** i18n key with which to explain the error to the user. */
export function userMessageKeyFor(kind: ProviderErrorKind): string {
    switch (kind) {
        case 'QUOTA_EXHAUSTED': return 'ai.error.quotaExhausted';
        case 'AUTH_FAILED': return 'ai.error.authFailed';
        case 'RATE_LIMITED': return 'ai.error.rateLimited';
        case 'UNREACHABLE': return 'ai.error.unreachable';
        default: return 'ai.error.generic';
    }
}
