import { config, type AIProvider } from '../../config';
import { Secret } from '../../services/secretVault';
import { tenantSecretsRepository } from '../../db/repositories/TenantSecretsRepository';
import type { AiScope, ResolvedCredentials } from './types';

/**
 * Where the key that pays for a call comes from.
 *
 * **From the vault, and from nowhere else.** Every scope — the guilds and the
 * instance itself — has its own credentials encrypted in `tenant_secrets`, and
 * reads them only there. There is no fallback to the environment.
 *
 * That is a choice, not a detail. An API key in `.env` is in clear text on
 * disk, ends up in the volume backups, shows up in `docker inspect` and
 * survives in copies of the file nobody remembers making; on top of that, as
 * long as the code knows how to read it, it stays a fallback that can make one
 * person pay for another's work without anything flagging it. In the vault it
 * is encrypted at rest, bound to its own scope, revocable and rotatable.
 *
 * A table with no keys therefore gets `AI_NOT_CONFIGURED` — a message with a
 * remedy — and never somebody else's key. It is configured from the settings
 * page, or with `npm run secrets:set` on an instance without the web app.
 *
 * The only secret that necessarily stays in the environment is
 * `SECRETS_MASTER_KEY`: it is the key that opens the vault, and it cannot live
 * inside the vault.
 */

/** Name of the credential in the vault, per provider. */
export const SECRET_KEY_BY_PROVIDER: Record<AIProvider, string | null> = {
    openai: 'openai.apiKey',
    gemini: 'gemini.apiKey',
    anthropic: 'anthropic.apiKey',
    'ollama-cloud': 'ollamaCloud.apiKey',
    // Local Ollama has no credentials: the SDK just wants a non-empty string.
    ollama: null,
};

/**
 * Resolves the credentials for a provider in the given scope.
 *
 * It does not throw: it returns `source: 'none'` when there is nothing. Deciding
 * whether that is fatal is up to the caller, because it depends on the phase —
 * without a Quality group key the recording is still valid and the session waits
 * for its summary, whereas without transcription there is no starting at all.
 */
export function resolveCredentials(provider: AIProvider, scope: AiScope): ResolvedCredentials {
    const secretKey = SECRET_KEY_BY_PROVIDER[provider];

    const base = {
        provider,
        scope,
        secretKey,
        projectId: provider === 'openai' ? config.ai.openAi.projectId || undefined : undefined,
        baseUrl: provider === 'ollama-cloud' ? config.ai.ollamaCloud.baseUrl : undefined,
    };

    // Local Ollama: no credential to resolve, it runs on the table's hardware.
    if (secretKey === null) {
        return { ...base, apiKey: new Secret('ollama'), source: 'tenant' };
    }

    const fromTenant = tenantSecretsRepository.getDecrypted({
        scope: 'guild',
        scopeId: scope.guildId,
        secretKey,
    });
    if (fromTenant) {
        return { ...base, apiKey: fromTenant, source: 'tenant' };
    }

    return { ...base, apiKey: null, source: 'none' };
}

/**
 * Flags that the provider rejected this credential.
 *
 * Feeds the "this key looks out of credit" box in the settings: it is the only
 * reliable way we have of saying it, since no provider exposes the remaining
 * balance to an ordinary API key.
 */
export function flagCredential(
    credentials: ResolvedCredentials,
    status: 'AUTH_FAILED' | 'QUOTA_EXHAUSTED',
    detail: string,
): void {
    if (credentials.source !== 'tenant' || !credentials.secretKey) return;
    tenantSecretsRepository.markVerification(
        { scope: 'guild', scopeId: credentials.scope.guildId, secretKey: credentials.secretKey },
        status,
        detail.slice(0, 500),
    );
}
