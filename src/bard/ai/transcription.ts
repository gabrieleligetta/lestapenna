import type { AIProvider } from '../../config';
import { Secret } from '../../services/secretVault';
import { tenantSecretsRepository } from '../../db/repositories/TenantSecretsRepository';
import { tenantAiSettingsRepository } from '../../db/repositories/TenantAiSettingsRepository';
import { resolveCredentials } from './credentials';
import { providerOfTranscriptionModel } from './modelCatalog';
import { wakeMethod } from '../../services/wake';
import type { TenantAiSettings } from './resolver';
import type { AiScope, ResolvedCredentials } from './types';

/**
 * How this table turns audio into text.
 *
 * Only two routes, both at its own expense:
 *
 *  - **its own PC**, with `lesta-penna-ai-server` installed on it. Zero cost in
 *    money, the cost in electricity and time is theirs;
 *  - **a cloud model**, charged to their key.
 *
 * **No automatic crossing between the two.** Falling back from a switched-off PC
 * to the cloud would mean spending money the user has not authorized, over a
 * fault that can often be fixed by turning a computer on. If anyone wants that,
 * it has to be an explicit switch.
 *
 * Whisper.cpp on the server no longer exists: it was too slow, and on a shared
 * instance it would have dumped everyone's compute onto the host.
 */

export type TranscriptionEngine = 'remote' | 'cloud';

/** The shape stored in `tenant_ai_settings`, under `transcription`. */
export interface TranscriptionSettings {
    engine?: TranscriptionEngine;
    remote?: {
        /** Base URL of the table's PC. The bot appends /health, /transcribe, /unload. */
        url?: string;
        /**
         * Which of the models installed on that PC to use.
         *
         * Absent means «whatever the PC has configured», which is how every
         * install behaved before there was a choice at all.
         */
        model?: string;
        connectTimeoutMs?: number;
        timeoutMs?: number;
        /**
         * Remote wake-up. `method` is the id of an implementation registered
         * in `services/wake/`; `options` are the fields *that* method
         * declares, so adding one does not touch this type.
         */
        wake?: {
            macAddress?: string;
            method?: string;
            options?: Record<string, string | number | undefined>;
            bootTimeoutMs?: number;
            pollIntervalMs?: number;
        };
    };
    cloud?: {
        provider?: AIProvider;
        model?: string;
    };
    /** Shutting the PC down at the end of a session: opt-in, it is a home computer. */
    power?: {
        shutdownEnabled?: boolean;
        delaySeconds?: number;
    };
}

export interface ResolvedWake {
    macAddress: string | null;
    method: string;
    options: Record<string, string | number | undefined>;
    /**
     * The method's secrets, already in clear and keyed by field name: the
     * method has to be able to send them, so they come back as strings here. It
     * is the only place in the project where that happens for these credentials.
     */
    secrets: Record<string, string | undefined>;
    bootTimeoutMs: number;
    pollIntervalMs: number;
}

/**
 * The table's PC, ready to use.
 *
 * Tokens leave here **already as headers**, not as a `Secret`. It is a
 * containment choice: they are credentials that have to be sent to a server, so
 * sooner or later they become strings again, and concentrating that step in a
 * single file is what makes it verifiable with a grep where the plaintext
 * exists. The people who use them — the worker, the shutdown — never call
 * `reveal()`.
 */
export interface ResolvedRemoteTranscription {
    url: string;
    /** `null` when the table did not choose: the PC decides, as it always did. */
    model: string | null;
    connectTimeoutMs: number;
    timeoutMs: number;
    /** `x-auth-token`, if the table protected its own server. Empty otherwise. */
    authHeaders: Record<string, string>;
    /** `x-shutdown-token`, per la richiesta di spegnimento. */
    shutdownHeaders: Record<string, string>;
    shutdownEnabled: boolean;
    shutdownDelaySeconds: number;
    wake: ResolvedWake;
}

export interface ResolvedCloudTranscription {
    provider: AIProvider;
    model: string;
    creds: ResolvedCredentials;
}

export type ResolvedTranscription =
    | { engine: 'remote'; remote: ResolvedRemoteTranscription }
    | { engine: 'cloud'; cloud: ResolvedCloudTranscription }
    | { engine: null; reason: 'NOT_CONFIGURED' | 'NO_CLOUD_KEY' };

/**
 * The providers that can really turn audio into text.
 *
 * **OpenAI and Gemini only**, and not out of preference: Anthropic does not
 * accept audio in the Messages API, and Ollama does not support audio input at
 * all. A table on either therefore picks another provider for transcription
 * alone — which has a select of its own precisely for that — or uses its own
 * PC, which costs nothing.
 *
 * Which model belongs to which of the two is not written here any more: it comes
 * from the catalogue (`ai/modelCatalog.ts`), so a model released after this file
 * was written is recognised without touching it.
 */
export const TRANSCRIPTION_PROVIDERS: AIProvider[] = ['openai', 'gemini'];

const DEFAULT_CLOUD_MODEL = 'gpt-4o-mini-transcribe';
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 2_700_000;
const DEFAULT_BOOT_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * The table's transcription settings, with the campaign's choice on top.
 *
 * **Only the model crosses.** The URL of the PC, its wake-up, the tokens, the
 * shutdown and the credentials stay the guild's: a campaign moves *which model*,
 * never *who pays* nor *whose machine* — the same guarantee `resolver.ts` gives
 * for the phases, and it is structural here too, because this function names
 * one field and copies nothing else.
 *
 * Two campaigns on one server legitimately want different models: one played in
 * a noisy room needs the accurate one, another is happy with the fast one.
 */
function settingsFor(scope: AiScope): TranscriptionSettings | undefined {
    const guild = tenantAiSettingsRepository
        .get<TenantAiSettings>('guild', scope.guildId)?.settings?.transcription;
    if (!scope.campaignId) return guild;

    const campaign = tenantAiSettingsRepository
        .get<TenantAiSettings>('campaign', String(scope.campaignId))?.settings?.transcription;
    if (!campaign) return guild;

    return {
        ...guild,
        cloud: {
            ...guild?.cloud,
            ...(campaign.cloud?.model ? { model: campaign.cloud.model } : {}),
            ...(campaign.cloud?.provider ? { provider: campaign.cloud.provider } : {}),
        },
        remote: {
            ...guild?.remote,
            ...(campaign.remote?.model ? { model: campaign.remote.model } : {}),
        },
    };
}

function secret(guildId: string, secretKey: string): Secret | null {
    return tenantSecretsRepository.getDecrypted({ scope: 'guild', scopeId: guildId, secretKey });
}

/** A token becomes a header, or nothing. The only place it becomes a string again. */
function header(name: string, value: Secret | null): Record<string, string> {
    return value ? { [name]: value.reveal() } : {};
}

/**
 * Vault name of a wake method's secret.
 *
 * Including the method's id stops two implementations with a field of the same
 * name from overwriting each other's credential.
 */
export function wakeSecretKey(method: string, field: string): string {
    return `wake.${method}.${field}`;
}

/** The secrets the chosen method declares, already decrypted. */
function wakeSecrets(guildId: string, method: string): Record<string, string | undefined> {
    const implementation = wakeMethod(method);
    if (!implementation) return {};

    const secrets: Record<string, string | undefined> = {};
    for (const field of implementation.fields) {
        if (!field.secret) continue;
        secrets[field.name] = secret(guildId, wakeSecretKey(method, field.name))?.reveal();
    }
    return secrets;
}

/**
 * Resolves the table's transcription configuration.
 *
 * It does not throw: it returns `engine: null` with the reason. It is up to the
 * caller to decide — `$listen` refuses to start, the worker marks the recording
 * as failed leaving the audio where it is.
 */
export function resolveTranscription(scope: AiScope): ResolvedTranscription {
    const settings = settingsFor(scope);
    const engine = settings?.engine;

    if (engine === 'remote') {
        const url = settings?.remote?.url?.replace(/\/+$/, '');
        if (!url) return { engine: null, reason: 'NOT_CONFIGURED' };

        const wake = settings?.remote?.wake ?? {};
        // `udp` di default: funziona quasi ovunque e non chiede credenziali.
        const method = wake.method ?? 'udp';
        return {
            engine: 'remote',
            remote: {
                url,
                model: settings?.remote?.model ?? null,
                connectTimeoutMs: settings?.remote?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
                timeoutMs: settings?.remote?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                authHeaders: header('x-auth-token', secret(scope.guildId, 'remoteWhisper.authToken')),
                shutdownHeaders: header('x-shutdown-token', secret(scope.guildId, 'remoteWhisper.shutdownToken')),
                shutdownEnabled: settings?.power?.shutdownEnabled === true,
                shutdownDelaySeconds: settings?.power?.delaySeconds ?? 60,
                wake: {
                    macAddress: wake.macAddress ?? null,
                    method,
                    options: wake.options ?? {},
                    secrets: wakeSecrets(scope.guildId, method),
                    bootTimeoutMs: wake.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS,
                    pollIntervalMs: wake.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
                },
            },
        };
    }

    if (engine === 'cloud') {
        const model = settings?.cloud?.model ?? DEFAULT_CLOUD_MODEL;
        const provider = settings?.cloud?.provider ?? providerOfTranscriptionModel(model) ?? 'openai';
        const creds = resolveCredentials(provider, scope);
        if (creds.source === 'none') return { engine: null, reason: 'NO_CLOUD_KEY' };

        return { engine: 'cloud', cloud: { provider, model, creds } };
    }

    return { engine: null, reason: 'NOT_CONFIGURED' };
}

/**
 * What the settings *say*, whether or not it can run right now.
 *
 * Deliberately separate from `resolveTranscription`, which answers «can this
 * work?» and returns nothing at all when a key is missing. A settings page has
 * to show the model that is configured even then — «this is what you would use,
 * you are missing the key» is a far more useful thing to display than an empty
 * field, which reads as «nothing is set» and invites setting it again.
 */
export function configuredTranscription(scope: AiScope): {
    engine: TranscriptionEngine | null;
    model: string | null;
    provider: AIProvider | null;
} {
    const settings = settingsFor(scope);

    if (settings?.engine === 'cloud') {
        const model = settings.cloud?.model ?? DEFAULT_CLOUD_MODEL;
        return {
            engine: 'cloud',
            model,
            provider: settings.cloud?.provider ?? providerOfTranscriptionModel(model) ?? 'openai',
        };
    }
    if (settings?.engine === 'remote') {
        return { engine: 'remote', model: settings.remote?.model ?? null, provider: null };
    }
    return { engine: null, model: null, provider: null };
}

/** True if the table can transcribe. Without it, a recording is mute audio. */
export function canTranscribe(scope: AiScope): boolean {
    return resolveTranscription(scope).engine !== null;
}
