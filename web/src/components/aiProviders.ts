import type { AiCredentialStatus, AiProvider } from '../api/types';

/**
 * The selectable providers: only the ones that cover the whole pipeline on their own.
 *
 * Anthropic does not transcribe and has no embedding models; Ollama Cloud does
 * not transcribe. A table configured on them would stop halfway through a
 * session, and would find out after recording. `ollama` stays because it is not
 * a key but the table's own hardware, and together with its PC for
 * transcription it gives a complete flow at zero cost.
 */
export const OFFERED_PROVIDERS: AiProvider[] = ['openai', 'gemini', 'ollama'];

/**
 * Providers that run on the table's own machine, and therefore need no key.
 *
 * The server says the same thing by mapping them to a `null` secret key
 * (`bard/ai/credentials.ts`); repeating it here is what lets the page decide
 * what to offer without a round trip.
 */
const KEYLESS_PROVIDERS: AiProvider[] = ['ollama'];

export interface ProviderAvailability {
    provider: AiProvider;
    /** Whether it can be picked at all: a key is stored, or none is needed. */
    usable: boolean;
    /** True when a key exists but the provider last refused or ran out. */
    troubled: boolean;
}

/**
 * Which providers this table can actually choose.
 *
 * The select used to offer all three unconditionally, so a table with only a
 * Gemini key could save a configuration on OpenAI and discover it during a
 * session. The gap it closes is real, but the answer is not to hide the others:
 * someone who never sees OpenAI in the list never learns it is an option. They
 * stay in the select, disabled, saying what they need.
 *
 * A stored key that last answered `AUTH_FAILED` or `QUOTA_EXHAUSTED` stays
 * **usable**. That status can be weeks old, or the credit may have been topped
 * up a minute ago; locking the table out of its own provider over a stale probe
 * would be worse than the warning that replaces it.
 */
export function providerAvailability(
    credentials: AiCredentialStatus[],
    providers: AiProvider[] = OFFERED_PROVIDERS,
): ProviderAvailability[] {
    const byProvider = new Map(credentials.map((entry) => [entry.provider, entry]));

    return providers.map((provider) => {
        const credential = byProvider.get(provider);
        const configured = credential?.configured === true;
        return {
            provider,
            usable: KEYLESS_PROVIDERS.includes(provider) || configured,
            troubled: configured
                && (credential?.verify_status === 'AUTH_FAILED'
                    || credential?.verify_status === 'QUOTA_EXHAUSTED'),
        };
    });
}

/** Whether this provider needs a key at all. Ollama is the table's own hardware. */
export function providerNeedsKey(provider: AiProvider): boolean {
    return !KEYLESS_PROVIDERS.includes(provider);
}

/** The id of the key field for a provider, so a hint can link straight to it. */
export function credentialFieldId(provider: AiProvider): string {
    return `ai-key-${provider}`;
}
