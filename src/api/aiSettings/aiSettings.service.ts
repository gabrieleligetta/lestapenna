import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import axios from 'axios';
import type { AIProvider } from '../../config';
import { SECRET_KEY_BY_PROVIDER, resolveCredentials } from '../../bard/ai/credentials';
import { classifyProviderError, redactKeyLike } from '../../bard/ai/providerErrors';
import {
    catalogRefreshedAt,
    imageModelsFor,
    modelsFor,
    providerOfTranscriptionModel,
    transcriptionModelsFor,
    transcriptionPricePerMinute,
    type ModelOption,
} from '../../bard/ai/modelCatalog';
import { probeProviderCredentials } from '../../bard/ai/providerFactory';
import { checkAiReadiness } from '../../bard/ai/readiness';
import {
    getAiContext,
    invalidateTenant,
    listOllamaModels,
    type TenantAiSettings,
} from '../../bard/ai/resolver';
import { EMBEDDING_MODELS, describeEmbedding, tenantOllamaUrl } from '../../bard/ai/embeddings';
import { estimateReindex, reindexCampaign } from '../../bard/rag/reindex';
import { estimatePhaseCost, estimateSessionCost } from '../../services/sessionCostEstimator';
import { getUsdEurRate, usdToEur } from '../../services/aiCostTransparency';
import { db } from '../../db/client';
import { getActiveCampaign } from '../../db';
import {
    TRANSCRIPTION_PROVIDERS,
    configuredTranscription,
    resolveTranscription,
    wakeSecretKey,
    type TranscriptionSettings,
} from '../../bard/ai/transcription';
import { listWakeMethods, sendWakeRequest, wakeMethod } from '../../services/wake';
import { hasPendingTranscriptionWork } from '../../services/remoteWhisperPower';
import {
    ALL_AI_PHASES,
    ON_DEMAND_AI_PHASES,
    tierOfPhase,
    type AiPhase,
    type AiScope,
    type AiTier,
} from '../../bard/ai/types';
import { tenantAiSettingsRepository } from '../../db/repositories/TenantAiSettingsRepository';
import {
    tenantSecretsRepository,
    type SecretVerifyStatus,
} from '../../db/repositories/TenantSecretsRepository';
import { secretVault } from '../../services/secretVault';
import {
    AI_PROVIDERS,
    KEYED_PROVIDERS,
    type CredentialStatusDto,
    type CredentialTestResultDto,
    type GuildAiSettingsDto,
    type PhaseConfigDto,
    type PhaseModelCostDto,
    type ModelOptionDto,
    type PhaseOverrideDto,
    type ProviderModelsDto,
    type RemoteWhisperModelsDto,
    type TierChoiceDto,
    type CampaignEmbeddingDto,
    type CampaignTranscriptionDto,
    type UpdateCampaignTranscriptionDto,
    type PricingOverrideDto,
    type ReindexEstimateDto,
    type SessionCostEstimateDto,
    type ReindexResultDto,
    type TranscriptionProbeDto,
    type RemotePcHealthDto,
    type RemotePcStatusDto,
    type ShutdownResultDto,
    type WakeAcceptedDto,
    type TranscriptionSettingsDto,
    type UpdateTranscriptionDto,
    type UpdateGuildAiSettingsDto,
} from './aiSettings.dto';

/** The tiniest model to probe a key with: the test must cost close to nothing. */
const PROBE_MODELS: Record<AIProvider, string> = {
    openai: 'gpt-5.4-nano',
    gemini: 'gemini-3.1-flash-lite',
    anthropic: 'claude-haiku-4-5',
    'ollama-cloud': 'glm-5.2:cloud',
    ollama: 'qwen3:8b',
};

const MODEL_MAX_CHARS = 120;

/** Every phase a campaign may override: the session pipeline plus the on-demand ones. */
const CONFIGURABLE_PHASES: readonly AiPhase[] = [...ALL_AI_PHASES, ...ON_DEMAND_AI_PHASES];

/**
 * The phases a campaign may actually override, which is not all of them.
 *
 * `embedding` is out, and it was never in: nothing reads
 * `settings.phases.embedding`. Embedding resolves from the model **pinned to
 * the campaign** at its first indexing, in a column of its own, so an override
 * written here changed nothing at run time while making the effective-config
 * table announce a model that would never be used.
 *
 * The real control is the reindex flow, and it has to be: switching model makes
 * every fragment already indexed invisible to search, so it asks first and
 * prices the recalculation. A select that saved silently could throw away a
 * campaign's whole memory with one click.
 */
const OVERRIDABLE_PHASES: readonly AiPhase[] = CONFIGURABLE_PHASES.filter(phase => phase !== 'embedding');

/** The catalogue speaks camelCase, the API snake_case. Only the names change. */
function toModelOptionDto(option: ModelOption): ModelOptionDto {
    return {
        id: option.id,
        label: option.label,
        recommended: option.recommended,
        input_per_million: option.inputPerMillion,
        output_per_million: option.outputPerMillion,
        per_minute_usd: option.perMinuteUsd,
        per_image_usd: option.perImageUsd,
        context_tokens: option.contextTokens,
        runs_on_your_hardware: option.runsOnYourHardware,
    };
}

/** The cheapest of the known transcription models. */
const DEFAULT_CLOUD_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

/**
 * How long a machine is given to come up, when the table has not configured one.
 *
 * Only reached by the refusal branch of «switch it on», which still has to tell
 * the page how long it would have waited. Same figure as `resolveTranscription`.
 */
const DEFAULT_BOOT_TIMEOUT_MS = 180_000;

@Injectable()
export class AiSettingsService {
    read(guildId: string, canManage = false): GuildAiSettingsDto {
        const scope: AiScope = { guildId };
        const stored = tenantAiSettingsRepository.get<TenantAiSettings>('guild', guildId)?.settings;
        const readiness = checkAiReadiness(scope);

        return {
            guild_id: guildId,
            quality: stored?.tiers?.quality ?? null,
            fast: stored?.tiers?.fast ?? null,
            image: stored?.phases?.image ?? null,
            effective: this.effectivePhases(scope),
            credentials: this.credentialStatuses(guildId),
            ready: readiness.ready,
            missing_providers: readiness.providers,
            can_manage: canManage,
        };
    }

    /**
     * Saves the only two choices the UI exposes.
     *
     * The per-phase overrides do not go through here: they live in a campaign's
     * advanced settings, which are a different scope. A `PUT` here must not be
     * able to wipe them by oversight, so only the `tiers` are rewritten.
     */
    update(guildId: string, patch: UpdateGuildAiSettingsDto, actorUserId: string): GuildAiSettingsDto {
        const current = tenantAiSettingsRepository.get<TenantAiSettings>('guild', guildId)?.settings ?? {};
        const tiers = { ...current.tiers };

        for (const tier of ['quality', 'fast'] as AiTier[]) {
            if (!(tier in patch)) continue;
            const choice = patch[tier];
            if (choice === null) delete tiers[tier];
            else if (choice !== undefined) tiers[tier] = this.validateChoice(guildId, choice, tier);
        }

        // The image model is a phase override, not a group: there is one image
        // select, and expanding a "group" of one would be ceremony for nothing.
        const phases = { ...current.phases };
        if ('image' in patch) {
            if (patch.image === null) delete phases.image;
            else if (patch.image !== undefined) phases.image = this.validateChoice(guildId, patch.image, null);
        }

        tenantAiSettingsRepository.put('guild', guildId, { ...current, tiers, phases }, actorUserId);
        invalidateTenant(guildId);
        // Chi è arrivato fin qui ha passato GuildManageGuard.
        return this.read(guildId, true);
    }

    putCredential(guildId: string, provider: AIProvider, apiKey: string, actorUserId: string): void {
        const secretKey = this.secretKeyFor(provider);

        if (!secretVault.isEnabled()) {
            // Without a master key the only alternative would be writing the key in
            // clear text: better to refuse and say so than to accept and betray.
            throw new ServiceUnavailableException('The secret vault is not configured on this instance');
        }

        const trimmed = apiKey.trim();
        if (!trimmed) throw new BadRequestException('The key must not be empty');

        tenantSecretsRepository.put({ scope: 'guild', scopeId: guildId, secretKey }, trimmed, actorUserId);
        invalidateTenant(guildId);
    }

    removeCredential(guildId: string, provider: AIProvider): void {
        tenantSecretsRepository.remove({
            scope: 'guild',
            scopeId: guildId,
            secretKey: this.secretKeyFor(provider),
        });
        invalidateTenant(guildId);
    }

    /**
     * Tests the key with the smallest possible request.
     *
     * The probe starts **from the server**: the key must never reach the
     * browser, and a local provider often sits on a network the browser cannot
     * see. The outcome is stored on `verify_status`, so the UI can show it even
     * after a reload — and it is also how exhausted credit is discovered, since
     * no provider exposes the remaining balance.
     */
    async testCredential(guildId: string, provider: AIProvider): Promise<CredentialTestResultDto> {
        const secretKey = this.secretKeyFor(provider);
        const model = PROBE_MODELS[provider];
        const identity = { scope: 'guild' as const, scopeId: guildId, secretKey };

        const probe = await this.probe(guildId, provider, model);

        tenantSecretsRepository.markVerification(identity, probe.status, probe.detail ?? '');
        invalidateTenant(guildId);

        return { provider, status: probe.status, detail: probe.detail, model };
    }

    async models(provider: AIProvider, guildId: string): Promise<ProviderModelsDto> {
        const installed = provider === 'ollama' ? await this.installedOllamaModels(guildId) : null;

        const forTier = (tier: AiTier) => (installed ?? []).length > 0
            ? installed!.map(id => ({
                id,
                label: null,
                recommended: false,
                inputPerMillion: null,
                outputPerMillion: null,
                perMinuteUsd: null,
                perImageUsd: null,
                contextTokens: null,
                runsOnYourHardware: true,
            }))
            : modelsFor(provider, tier);

        return {
            provider,
            quality: forTier('quality').map(toModelOptionDto),
            fast: forTier('fast').map(toModelOptionDto),
            transcription: TRANSCRIPTION_PROVIDERS.includes(provider)
                ? transcriptionModelsFor(provider).map(toModelOptionDto)
                : [],
            // Ollama is absent here for a plainer reason than preference: it has
            // no image-generation endpoint, so the list is empty rather than an
            // option that always fails.
            image: imageModelsFor(provider).map(toModelOptionDto),
            refreshed_at: catalogRefreshedAt(),
        };
    }

    /**
     * What is really pulled onto this table's Ollama node.
     *
     * No catalogue can answer this: the models on someone's home PC are known
     * only by that PC. When it does not answer — switched off, which is the
     * normal state of a home machine — the curated list stands in, so the select
     * is never empty and the table can still configure the thing it will turn on
     * later.
     */
    private async installedOllamaModels(guildId: string): Promise<string[] | null> {
        const url = tenantOllamaUrl({ guildId });
        if (!url) return null;
        return listOllamaModels(url);
    }

    // ============================================
    // TRASCRIZIONE
    // ============================================

    readTranscription(guildId: string): TranscriptionSettingsDto {
        const stored = tenantAiSettingsRepository
            .get<TenantAiSettings>('guild', guildId)?.settings?.transcription ?? {};
        const resolved = resolveTranscription({ guildId });
        const wake = stored.remote?.wake ?? {};

        const model = stored.cloud?.model ?? DEFAULT_CLOUD_TRANSCRIPTION_MODEL;

        return {
            engine: stored.engine ?? null,
            remote: {
                url: stored.remote?.url ?? null,
                model: stored.remote?.model ?? null,
                auth_token_configured: tenantSecretsRepository.getMeta({
                    scope: 'guild', scopeId: guildId, secretKey: 'remoteWhisper.authToken',
                }) !== undefined,
                shutdown_token_configured: tenantSecretsRepository.getMeta({
                    scope: 'guild', scopeId: guildId, secretKey: 'remoteWhisper.shutdownToken',
                }) !== undefined,
                shutdown_enabled: stored.power?.shutdownEnabled === true,
                wake: {
                    mac_address: wake.macAddress ?? null,
                    method: wake.method ?? 'udp',
                    options: wake.options ?? {},
                    configured_secrets: this.configuredWakeSecrets(guildId, wake.method ?? 'udp'),
                },
            },
            cloud: {
                provider: stored.cloud?.provider ?? providerOfTranscriptionModel(model) ?? 'openai',
                model,
            },
            usable: resolved.engine !== null,
            reason: resolved.engine === null ? resolved.reason : null,
            // On your own hardware it is €0, and that should be said: it still costs time and
            // electricity, and it is the only way to compare the two routes.
            cloud_usd_per_minute: stored.engine === 'cloud' ? transcriptionPricePerMinute(model) : null,
        };
    }

    updateTranscription(
        guildId: string,
        patch: UpdateTranscriptionDto,
        actorUserId: string,
    ): TranscriptionSettingsDto {
        const current = tenantAiSettingsRepository
            .get<TenantAiSettings>('guild', guildId)?.settings ?? {};
        const transcription: TranscriptionSettings = { ...current.transcription };

        if ('engine' in patch) {
            transcription.engine = patch.engine ?? undefined;
        }
        if ('remote_url' in patch) {
            transcription.remote = { ...transcription.remote, url: this.validateRemoteUrl(patch.remote_url) };
        }
        if ('remote_model' in patch) {
            // Not validated against the PC's list: that PC may be off right now,
            // and refusing to save a choice because the machine is asleep would
            // make the setting unusable exactly when someone is preparing for a
            // session. An id it does not have comes back as a 400 from the PC
            // itself, with the list of what it does have.
            transcription.remote = {
                ...transcription.remote,
                model: this.validateModelName(patch.remote_model),
            };
        }
        if ('shutdown_enabled' in patch) {
            transcription.power = { ...transcription.power, shutdownEnabled: patch.shutdown_enabled === true };
        }
        if (patch.wake) {
            const method = patch.wake.method ?? transcription.remote?.wake?.method ?? 'udp';
            if (!wakeMethod(method)) throw new BadRequestException(`Unknown wake method: ${method}`);
            transcription.remote = {
                ...transcription.remote,
                wake: {
                    macAddress: patch.wake.mac_address ?? undefined,
                    method,
                    // The fields are declared by the method: here we do not even
                    // know their names, and that is what makes adding one
                    // a change to a single file.
                    options: patch.wake.options ?? {},
                },
            };
        }
        if (patch.cloud_provider || patch.cloud_model) {
            const model = (patch.cloud_model ?? transcription.cloud?.model ?? DEFAULT_CLOUD_TRANSCRIPTION_MODEL).trim();
            if (!model) throw new BadRequestException('A transcription model is required');
            transcription.cloud = {
                provider: patch.cloud_provider ?? providerOfTranscriptionModel(model) ?? 'openai',
                model,
            };
        }

        tenantAiSettingsRepository.put('guild', guildId, { ...current, transcription }, actorUserId);
        invalidateTenant(guildId);
        return this.readTranscription(guildId);
    }

    /** The available wake methods, with the fields each of them asks for. */
    wakeMethods() {
        return listWakeMethods().map(method => ({
            id: method.id,
            label: method.label,
            description: method.description,
            fields: method.fields.map(field => ({
                name: field.name,
                kind: field.kind,
                label: field.label,
                hint: field.hint ?? null,
                required: field.required === true,
                placeholder: field.placeholder ?? null,
                secret: field.secret === true,
            })),
        }));
    }

    /** Stores a secret field of the wake method (router password, token…). */
    putWakeSecret(guildId: string, method: string, field: string, value: string, actorUserId: string): void {
        const implementation = wakeMethod(method);
        const declared = implementation?.fields.find(f => f.name === field && f.secret);
        if (!declared) throw new BadRequestException(`${method} has no secret field named ${field}`);
        if (!secretVault.isEnabled()) {
            throw new ServiceUnavailableException('The secret vault is not configured on this instance');
        }
        const trimmed = value?.trim();
        if (!trimmed) throw new BadRequestException('The value must not be empty');

        tenantSecretsRepository.put(
            { scope: 'guild', scopeId: guildId, secretKey: wakeSecretKey(method, field) },
            trimmed,
            actorUserId,
        );
        invalidateTenant(guildId);
    }

    private configuredWakeSecrets(guildId: string, method: string): string[] {
        const implementation = wakeMethod(method);
        if (!implementation) return [];
        return implementation.fields
            .filter(field => field.secret)
            .filter(field => tenantSecretsRepository.getMeta({
                scope: 'guild', scopeId: guildId, secretKey: wakeSecretKey(method, field.name),
            }) !== undefined)
            .map(field => field.name);
    }

    /**
     * Access token for the table's PC.
     *
     * Write-only like every credential: its existence can be known, its value
     * cannot. It has a route of its own and does not go through the settings
     * `PUT`, which instead returns the state.
     */
    putTranscriptionAuthToken(guildId: string, token: string, actorUserId: string): void {
        this.putRemoteWhisperSecret(guildId, 'remoteWhisper.authToken', token, actorUserId);
    }

    /**
     * The token that lets this table switch its own machine off.
     *
     * A separate secret from the auth token, matching the machine's own
     * separation (`REMOTE_SHUTDOWN_TOKEN` next to the auth one): reading
     * transcripts from a computer and turning it off are not the same
     * permission. It was read from the vault since the automatic post-session
     * shutdown existed, but nothing could ever write it — which is why remote
     * shutdown was, in practice, unconfigurable from the web.
     */
    putTranscriptionShutdownToken(guildId: string, token: string, actorUserId: string): void {
        this.putRemoteWhisperSecret(guildId, 'remoteWhisper.shutdownToken', token, actorUserId);
    }

    private putRemoteWhisperSecret(
        guildId: string,
        secretKey: string,
        token: string,
        actorUserId: string,
    ): void {
        if (!secretVault.isEnabled()) {
            throw new ServiceUnavailableException('The secret vault is not configured on this instance');
        }
        const trimmed = token?.trim();
        if (!trimmed) throw new BadRequestException('The token must not be empty');

        tenantSecretsRepository.put({ scope: 'guild', scopeId: guildId, secretKey }, trimmed, actorUserId);
        invalidateTenant(guildId);
    }

    /**
     * Probes the table's PC, **from the server**.
     *
     * The token must not reach the browser, and that PC normally sits on a
     * Tailscale network the browser cannot see: a client-side test would say
     * "unreachable" even to someone whose setup is perfectly fine.
     */
    async testTranscription(guildId: string): Promise<TranscriptionProbeDto> {
        const { health: _health, checked_at: _checkedAt, ...probe } = await this.remotePcStatus(guildId);
        return probe;
    }

    /**
     * The state of the table's machine, with what it says about itself.
     *
     * Same probe as `testTranscription`, except it keeps the body. `/health` on
     * the machine reports the GPU, the Whisper model currently loaded and the
     * uptime; discarding all of it left the page able to say «on» and nothing
     * else, which is not what someone checking before a session wants to know.
     *
     * A `GET`, because it changes nothing and the page asks it on open and on a
     * timer while the machine boots.
     */
    async remotePcStatus(guildId: string): Promise<RemotePcStatusDto> {
        const checkedAt = Date.now();
        const resolved = resolveTranscription({ guildId });

        if (resolved.engine !== 'remote') {
            return {
                status: 'NOT_CONFIGURED',
                detail: 'Nessun PC configurato per questo tavolo.',
                checked_at: checkedAt,
                health: null,
            };
        }

        try {
            const response = await axios.get(`${resolved.remote.url}/health`, {
                timeout: resolved.remote.connectTimeoutMs,
                headers: resolved.remote.authHeaders,
            });
            return {
                status: 'OK',
                detail: null,
                checked_at: checkedAt,
                health: this.parseRemoteHealth(response.data),
            };
        } catch (error: any) {
            if (error?.response?.status === 401 || error?.response?.status === 403) {
                return {
                    status: 'UNAUTHORIZED',
                    detail: 'Il PC ha rifiutato il token.',
                    checked_at: checkedAt,
                    health: null,
                };
            }
            // Being switched off is a home computer's normal state, not a fault.
            return {
                status: 'UNREACHABLE',
                detail: redactKeyLike(String(error?.message ?? '')).slice(0, 300),
                checked_at: checkedAt,
                health: null,
            };
        }
    }

    /**
     * The machine's own `/health` body, read defensively.
     *
     * Every field is optional: the table controls that machine and may be
     * running an older build of `lesta-penna-ai-server`. A missing field is
     * `null` — «we do not know» — never a made-up default.
     */
    private parseRemoteHealth(body: any): RemotePcHealthDto | null {
        if (!body || typeof body !== 'object') return null;

        const asString = (value: unknown) => (typeof value === 'string' ? value : null);
        const asNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
        // `uptime` arrives as "3600s" from the machine, not as a number.
        const seconds = (value: unknown) => {
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            const match = typeof value === 'string' ? value.match(/^(\d+)\s*s$/) : null;
            return match ? Number(match[1]) : null;
        };

        return {
            gpu: typeof body.whisper?.gpu === 'boolean' ? body.whisper.gpu : null,
            accelerator: asString(body.whisper?.accelerator),
            model: asString(body.whisper?.model),
            cpu: asString(body.hardware?.cpu),
            cpu_cores: asNumber(body.hardware?.cpuCores),
            total_memory: asString(body.hardware?.totalMemory),
            free_memory: asString(body.hardware?.freeMemory),
            uptime_seconds: seconds(body.process?.uptime),
        };
    }

    /**
     * The Whisper models installed on the table's PC.
     *
     * A proxy, and it has to be: the PC lives on the table's tailnet, so the
     * browser cannot reach it — and the auth token must not leave the server
     * anyway.
     *
     * A PC that does not answer is not an error. It is a home computer, being
     * off is its normal state, and the settings page says so rather than showing
     * a failure.
     */
    async remoteTranscriptionModels(guildId: string): Promise<RemoteWhisperModelsDto> {
        const resolved = resolveTranscription({ guildId });
        if (resolved.engine !== 'remote') {
            return { models: [], current: null, reason: 'NOT_REMOTE' };
        }

        try {
            const response = await axios.get(`${resolved.remote.url}/models`, {
                timeout: resolved.remote.connectTimeoutMs,
                headers: resolved.remote.authHeaders,
            });
            const models = Array.isArray(response.data?.models)
                ? response.data.models
                    .map((entry: any) => (typeof entry === 'string' ? entry : entry?.id))
                    .filter((id: unknown): id is string => typeof id === 'string')
                : [];
            return { models, current: response.data?.current ?? null, reason: null };
        } catch (error: any) {
            const status = error?.response?.status;
            return {
                models: [],
                current: null,
                // A PC running a version without /models answers 404: that is
                // «this one cannot tell us», i.e. the same as unreachable for
                // the purpose of filling a select.
                reason: status === 401 || status === 403 ? 'UNAUTHORIZED' : 'UNREACHABLE',
            };
        }
    }

    /**
     * Switches the PC on and waits for it to answer.
     *
     * A separate action from the test, and not an automatic fallback inside it:
     * a boot legitimately takes minutes, and two buttons tell the story of
     * something that happens in two stages better.
     */
    async wakeTranscription(guildId: string): Promise<WakeAcceptedDto> {
        const resolved = resolveTranscription({ guildId });

        if (resolved.engine !== 'remote' || !resolved.remote.wake.macAddress) {
            return {
                status: 'NOT_CONFIGURED',
                detail: 'Nessun MAC configurato: non c\'è nulla da svegliare.',
                boot_timeout_ms: DEFAULT_BOOT_TIMEOUT_MS,
            };
        }

        const bootTimeoutMs = resolved.remote.wake.bootTimeoutMs;

        // Sends and returns, instead of holding the request open for the three
        // minutes a boot can take: a request that long dies to a proxy timeout
        // and leaves the page unable to say whether anything happened at all.
        // The caller polls the status endpoint, which is also what draws the
        // progress. The worker keeps using `wakeAndWait`, because it does have
        // to know the answer before deciding where to transcribe.
        const sent = await sendWakeRequest({
            macAddress: resolved.remote.wake.macAddress,
            method: resolved.remote.wake.method,
            options: resolved.remote.wake.options,
            secrets: resolved.remote.wake.secrets,
        });

        return sent.sent
            ? { status: 'WAKING', detail: null, boot_timeout_ms: bootTimeoutMs }
            : { status: 'FAILED', detail: redactKeyLike(sent.reason).slice(0, 300), boot_timeout_ms: bootTimeoutMs };
    }

    /**
     * Switches the table's machine off, now, because somebody asked.
     *
     * The automatic shutdown at the end of a session already existed; this is
     * the same request with a person behind it, and it needs the same guard:
     * audio still in the queue means the session would be lost, so it refuses.
     *
     * The refusals are statuses, not exceptions. Each of them names something
     * to configure or a reason to wait, and an HTTP error would flatten five
     * different remedies into one red box.
     */
    async shutdownRemotePc(guildId: string): Promise<ShutdownResultDto> {
        const resolved = resolveTranscription({ guildId });

        if (resolved.engine !== 'remote' || !resolved.remote.url) {
            return { status: 'NOT_CONFIGURED', detail: 'Nessun PC configurato per questo tavolo.', delay_seconds: null };
        }
        if (!resolved.remote.shutdownEnabled) {
            return { status: 'DISABLED', detail: null, delay_seconds: null };
        }
        if (Object.keys(resolved.remote.shutdownHeaders).length === 0) {
            return { status: 'NO_TOKEN', detail: null, delay_seconds: null };
        }
        if (await hasPendingTranscriptionWork()) {
            return { status: 'BUSY', detail: null, delay_seconds: null };
        }

        const delaySeconds = resolved.remote.shutdownDelaySeconds;

        try {
            await axios.post(
                `${resolved.remote.url}/shutdown`,
                { shutdown: true, delaySeconds, reason: 'manual_request' },
                {
                    timeout: resolved.remote.connectTimeoutMs,
                    headers: { 'Content-Type': 'application/json', ...resolved.remote.shutdownHeaders },
                },
            );
            return { status: 'SCHEDULED', detail: null, delay_seconds: delaySeconds };
        } catch (error: any) {
            const status = error?.response?.status;
            if (status === 401 || status === 403) {
                // 403 is what the machine answers when its own
                // ENABLE_REMOTE_SHUTDOWN is off: the table said yes here and no
                // there, and only the machine's side can fix it.
                return {
                    status: status === 403 ? 'DISABLED' : 'UNAUTHORIZED',
                    detail: 'Il PC ha rifiutato la richiesta di spegnimento.',
                    delay_seconds: null,
                };
            }
            return {
                status: 'UNREACHABLE',
                detail: redactKeyLike(String(error?.message ?? '')).slice(0, 300),
                delay_seconds: null,
            };
        }
    }

    /**
     * The PC's URL: `http://` and private hosts are legitimate — Tailscale is
     * the whole point. We reject schemes that are not HTTP, which would be of
     * no use to a server and would open file-reading paths.
     */
    private validateRemoteUrl(raw: string | null | undefined): string | undefined {
        const value = raw?.trim();
        if (!value) return undefined;
        let parsed: URL;
        try {
            parsed = new URL(value);
        } catch {
            throw new BadRequestException('The address of your machine is not a valid URL');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new BadRequestException('Only http:// and https:// are accepted');
        }
        return value.replace(/\/+$/, '');
    }

    /** Per-phase overrides set on this campaign. */
    campaignOverrides(campaignId: number): PhaseOverrideDto[] {
        const stored = tenantAiSettingsRepository
            .get<TenantAiSettings>('campaign', String(campaignId))?.settings;
        return Object.entries(stored?.phases ?? {})
            // An `embedding` entry can only be a leftover from when the UI
            // offered that row. Hiding it here is what lets it heal: the page
            // never shows it, so the next save — which replaces the set
            // wholesale — drops it from storage.
            .filter(([phase]) => OVERRIDABLE_PHASES.includes(phase as AiPhase))
            .map(([phase, choice]) => ({
                phase: phase as AiPhase,
                provider: choice!.provider,
                model: choice!.model,
            }));
    }

    /**
     * Replaces the campaign's overrides wholesale.
     *
     * **Models** only: the keys stay the guild's, and there is no way to name
     * one here. It is the guarantee that the advanced section moves which model
     * and never who pays.
     */
    saveCampaignOverrides(
        guildId: string,
        campaignId: number,
        overrides: PhaseOverrideDto[],
        actorUserId: string,
    ): PhaseOverrideDto[] {
        const phases: TenantAiSettings['phases'] = {};
        for (const override of overrides ?? []) {
            // Refused rather than dropped: nothing legitimate sends `embedding`
            // any more, so a request carrying one is a stale client or a direct
            // call, and letting it through silently would leave the caller
            // believing it had changed which model indexes this campaign.
            if (override.phase === 'embedding') {
                throw new BadRequestException(
                    'The embedding model is not a per-phase override: it is pinned to the campaign '
                    + 'and changed through a reindex, which prices recalculating the existing fragments',
                );
            }
            if (!OVERRIDABLE_PHASES.includes(override.phase)) {
                throw new BadRequestException(`Unknown phase: ${override.phase}`);
            }
            // The key check is the guild's, because the key is: a campaign
            // override moves which model, never who pays for it.
            phases[override.phase] = this.validateChoice(
                guildId, { provider: override.provider, model: override.model }, 'fast',
            );
        }

        // Merged, not replaced: writing `{ phases }` alone used to drop the rest
        // of this campaign's settings, so choosing a model for one phase quietly
        // switched the agentic summary back off. The phases are still fully
        // rewritten — this endpoint owns them — but nothing else is touched.
        const current = tenantAiSettingsRepository
            .get<TenantAiSettings>('campaign', String(campaignId))?.settings ?? {};
        tenantAiSettingsRepository.put(
            'campaign', String(campaignId), { ...current, phases }, actorUserId,
        );
        invalidateTenant(guildId);
        return this.campaignOverrides(campaignId);
    }

    /**
     * Which transcription model this campaign uses.
     *
     * Model only. The PC's address, its wake-up, the tokens and the keys are not
     * even nameable from this route — the guarantee that a campaign moves *which
     * model* and never *who pays* is the shape of this method, not a convention
     * to remember.
     */
    saveCampaignTranscription(
        guildId: string,
        campaignId: number,
        patch: UpdateCampaignTranscriptionDto,
        actorUserId: string,
    ): CampaignTranscriptionDto {
        const current = tenantAiSettingsRepository
            .get<TenantAiSettings>('campaign', String(campaignId))?.settings ?? {};
        const transcription: TranscriptionSettings = { ...current.transcription };

        if ('cloud_model' in patch) {
            const model = this.validateModelName(patch.cloud_model);
            transcription.cloud = model
                ? { model, provider: providerOfTranscriptionModel(model) ?? undefined }
                : undefined;
        }
        if ('remote_model' in patch) {
            const model = this.validateModelName(patch.remote_model);
            transcription.remote = model ? { model } : undefined;
        }

        tenantAiSettingsRepository.put(
            'campaign', String(campaignId), { ...current, transcription }, actorUserId,
        );
        invalidateTenant(guildId);
        return this.readCampaignTranscription({ guildId, campaignId });
    }

    /**
     * What a phase would cost with a model that has not been chosen yet.
     *
     * The whole-session estimate cannot answer this: it prices what is already
     * configured, so by the time it moves the decision has been taken. This is
     * the figure that belongs next to an open select.
     */
    async estimatePhase(
        scope: AiScope,
        phase: AiPhase,
        provider: AIProvider,
        model: string,
        audioMinutes: number,
    ): Promise<PhaseModelCostDto> {
        if (!CONFIGURABLE_PHASES.includes(phase)) {
            throw new BadRequestException(`Unknown phase: ${phase}`);
        }
        if (!AI_PROVIDERS.includes(provider)) {
            throw new BadRequestException(`Unknown provider: ${provider}`);
        }
        const chosen = this.validateModelName(model);
        if (!chosen) throw new BadRequestException('A model is required');

        const estimate = estimatePhaseCost(scope, phase, provider, chosen, audioMinutes);
        const rate = await getUsdEurRate();

        return {
            phase,
            provider,
            model: chosen,
            audio_minutes: audioMinutes,
            input_tokens: estimate.inputTokens,
            output_tokens: estimate.outputTokens,
            cost_usd: estimate.costUsd,
            cost_eur: estimate.costUsd === null ? null : usdToEur(estimate.costUsd, rate),
            pricing_source: estimate.pricingSource,
            calibrated: estimate.calibrated,
            runs_on_your_hardware: estimate.resourceIntensive,
        };
    }

    /**
     * What this campaign will really transcribe with.
     *
     * The engine is reported but not settable here: choosing between one's own
     * PC and the cloud is choosing who pays, and that stays with the guild.
     */
    readCampaignTranscription(scope: AiScope): CampaignTranscriptionDto {
        const own = tenantAiSettingsRepository
            .get<TenantAiSettings>('campaign', String(scope.campaignId))?.settings?.transcription;
        // What is configured, and separately whether it can run: a missing key
        // must not blank out the model the table chose.
        const configured = configuredTranscription(scope);
        const resolved = resolveTranscription(scope);

        return {
            engine: configured.engine,
            reason: resolved.engine === null ? resolved.reason : null,
            effective_model: configured.model,
            effective_provider: configured.provider,
            cloud_model: own?.cloud?.model ?? null,
            remote_model: own?.remote?.model ?? null,
            usd_per_minute: configured.engine === 'cloud' && configured.model
                ? transcriptionPricePerMinute(configured.model)
                : null,
        };
    }

    /**
     * Which summary pipeline this campaign uses.
     *
     * It is a campaign choice and not a guild one because two tables on the same
     * server may want different things — and often do: a long campaign with a
     * rich world gains from the agentic flow, a one-shot does not.
     */
    setCampaignFlow(
        guildId: string,
        campaignId: number,
        agenticSummary: boolean,
        actorUserId: string,
    ): boolean {
        const current = tenantAiSettingsRepository
            .get<TenantAiSettings>('campaign', String(campaignId))?.settings ?? {};

        tenantAiSettingsRepository.put(
            'campaign', String(campaignId),
            { ...current, features: { ...current.features, agenticSummary } },
            actorUserId,
        );
        invalidateTenant(guildId);
        return agenticSummary;
    }

    /**
     * State of a campaign's embedding and the possible alternatives.
     *
     * The options are filtered by what the table can **actually** use: an Ollama
     * model with no reachable node, or a cloud one with no key, would be a
     * choice that fails on the first fragment.
     */
    campaignEmbedding(scope: AiScope): CampaignEmbeddingDto {
        const campaignId = scope.campaignId!;
        const current = db.prepare(
            'SELECT embedding_model, embedding_dimension FROM campaigns WHERE id = ?',
        ).get(campaignId) as { embedding_model: string | null; embedding_dimension: number | null };

        const fragments = db.prepare(
            'SELECT COUNT(*) AS n FROM knowledge_fragments WHERE campaign_id = ?',
        ).get(campaignId) as { n: number };

        const hasOwnOllama = tenantOllamaUrl(scope) !== null;
        const options = Object.values(EMBEDDING_MODELS)
            .filter(info => info.provider === 'ollama'
                ? hasOwnOllama
                : resolveCredentials(info.provider, scope).source !== 'none')
            .map(info => ({
                model: info.model,
                provider: info.provider,
                dimension: info.dimension,
                usd_per_million_tokens: info.usdPerMillionTokens,
            }));

        return {
            model: current?.embedding_model ?? null,
            dimension: current?.embedding_dimension ?? null,
            fragments: fragments.n,
            options,
        };
    }

    estimateReindex(campaignId: number, model: string): ReindexEstimateDto {
        if (!EMBEDDING_MODELS[model]) throw new BadRequestException(`Unknown embedding model: ${model}`);
        const estimate = estimateReindex(campaignId, model);
        return {
            fragments: estimate.fragments,
            current_model: estimate.currentModel,
            target_model: estimate.targetModel,
            estimated_usd: estimate.estimatedUsd,
        };
    }

    async reindex(guildId: string, campaignId: number, model: string): Promise<ReindexResultDto> {
        if (!EMBEDDING_MODELS[model]) throw new BadRequestException(`Unknown embedding model: ${model}`);
        const result = await reindexCampaign(campaignId, model);
        invalidateTenant(guildId);
        return result;
    }

    /**
     * Estimate for a session, for the guild or for one of its campaigns.
     *
     * Without a `campaignId` the embedding row would price a fresh default
     * instead of the model a campaign already indexed with — a table with an
     * active campaign is never "starting from zero". `$listen` decides which
     * campaign the next session belongs to from the same `is_active` flag
     * (`getActiveCampaign`), so this is the same answer the recording itself
     * would give.
     */
    async estimateSession(scope: AiScope, audioMinutes: number): Promise<SessionCostEstimateDto> {
        const active = scope.campaignId ? undefined : getActiveCampaign(scope.guildId);
        const resolvedScope = active ? { ...scope, campaignId: active.id } : scope;
        const estimate = await estimateSessionCost(resolvedScope, audioMinutes);
        return {
            audio_minutes: estimate.audioMinutes,
            per_phase: estimate.perPhase.map(phase => ({
                phase: phase.phase,
                provider: phase.provider,
                model: phase.model,
                input_tokens: phase.inputTokens,
                output_tokens: phase.outputTokens,
                input_per_million: phase.inputPerMillion,
                output_per_million: phase.outputPerMillion,
                cost_usd: phase.costUsd,
                pricing_source: phase.pricingSource,
                resource_intensive: phase.resourceIntensive,
            })),
            total_usd: estimate.totalUsd,
            total_eur: estimate.totalEur,
            pricing_complete: estimate.pricingComplete,
            resource_intensive_phases: estimate.resourceIntensivePhases,
            calibrated: estimate.calibrated,
        };
    }

    /** Rates declared by the table, which win over our price list. */
    pricingOverrides(guildId: string): PricingOverrideDto[] {
        const settings = tenantAiSettingsRepository.get<TenantAiSettings>('guild', guildId)?.settings;
        return (settings?.pricingOverrides ?? []).map(o => ({
            model: o.model,
            input_per_million: o.inputPerMillion,
            output_per_million: o.outputPerMillion,
            cached_input_per_million: o.cachedInputPerMillion,
            per_image_usd: o.perImageUsd,
        }));
    }

    savePricingOverrides(
        guildId: string,
        overrides: PricingOverrideDto[],
        actorUserId: string,
    ): PricingOverrideDto[] {
        const current = tenantAiSettingsRepository.get<TenantAiSettings>('guild', guildId)?.settings ?? {};

        const parsed = (overrides ?? []).map(o => {
            const model = typeof o.model === 'string' ? o.model.trim() : '';
            if (!model) throw new BadRequestException('A model is required for each price');
            for (const value of [o.input_per_million, o.output_per_million]) {
                if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
                    throw new BadRequestException(`Invalid price for ${model}`);
                }
            }
            // Optional, and validated only when present: most declared rates
            // are for text models, which have no per-picture price to give.
            if (o.per_image_usd !== undefined && o.per_image_usd !== null) {
                if (typeof o.per_image_usd !== 'number'
                    || !Number.isFinite(o.per_image_usd)
                    || o.per_image_usd < 0) {
                    throw new BadRequestException(`Invalid per-image price for ${model}`);
                }
            }
            return {
                model,
                inputPerMillion: o.input_per_million,
                outputPerMillion: o.output_per_million,
                cachedInputPerMillion: o.cached_input_per_million,
                perImageUsd: o.per_image_usd ?? undefined,
            };
        });

        tenantAiSettingsRepository.put(
            'guild', guildId, { ...current, pricingOverrides: parsed }, actorUserId,
        );
        invalidateTenant(guildId);
        return this.pricingOverrides(guildId);
    }

    /** What a campaign will actually use, read-only. */
    effectivePhases(scope: AiScope): PhaseConfigDto[] {
        const ctx = getAiContext(scope);
        // The on-demand phases are listed here but not in `ALL_AI_PHASES`: they
        // are configurable per campaign like the others, while staying out of
        // the readiness check that decides whether a table may record at all.
        return [...ALL_AI_PHASES, ...ON_DEMAND_AI_PHASES].map(phase => {
            // Embedding does not come from the per-phase resolver. It is pinned
            // to the campaign at its first indexing and falls back to the key
            // the table has, so asking `ai.config.json` produced a permanent
            // «Ollama · nomic-embed-text» — free, on your own hardware — for
            // tables whose indexing was in fact billed to Gemini.
            if (phase === 'embedding') {
                const embedding = describeEmbedding(scope);
                return {
                    phase,
                    provider: embedding?.provider ?? ctx.phaseConfig(phase).provider,
                    model: embedding?.model ?? ctx.phaseConfig(phase).model,
                    tier: null,
                };
            }
            const config = ctx.phaseConfig(phase);
            return { phase, provider: config.provider, model: config.model, tier: tierOfPhase(phase) };
        });
    }

    private async probe(
        guildId: string,
        provider: AIProvider,
        model: string,
    ): Promise<{ status: SecretVerifyStatus; detail: string | null }> {
        const creds = resolveCredentials(provider, { guildId });
        if (creds.source === 'none') {
            return { status: 'AUTH_FAILED', detail: 'Nessuna chiave configurata per questo provider.' };
        }

        try {
            await probeProviderCredentials(creds, model);
            return { status: 'OK', detail: null };
        } catch (error) {
            const classified = classifyProviderError(provider, error);
            const status: SecretVerifyStatus =
                classified.kind === 'QUOTA_EXHAUSTED' ? 'QUOTA_EXHAUSTED'
                    : classified.kind === 'AUTH_FAILED' ? 'AUTH_FAILED'
                        : classified.kind === 'UNREACHABLE' ? 'UNREACHABLE'
                            // A 400 on the test model says the key was
                            // accepted: authentication went through.
                            : 'OK';
            // The provider's message may contain the key itself.
            return { status, detail: redactKeyLike(classified.raw).slice(0, 300) || null };
        }
    }

    private credentialStatuses(guildId: string): CredentialStatusDto[] {
        const metas = tenantSecretsRepository.listMeta('guild', guildId);

        return KEYED_PROVIDERS
            .filter(provider => SECRET_KEY_BY_PROVIDER[provider] !== null)
            .map(provider => {
                const secretKey = SECRET_KEY_BY_PROVIDER[provider]!;
                const meta = metas.find(m => m.secretKey === secretKey);
                return {
                    provider,
                    secret_key: secretKey,
                    configured: meta !== undefined,
                    hint: meta?.hint ?? null,
                    verify_status: meta?.verifyStatus ?? null,
                    verify_error: meta?.verifyError ?? null,
                    last_verified_at: meta?.lastVerifiedAt ?? null,
                    updated_at: meta?.updatedAt ?? null,
                };
            });
    }

    private secretKeyFor(provider: AIProvider): string {
        // Only providers that cover the whole pipeline accept a key.
        // Storing one for Anthropic would mean keeping a credential that can
        // never carry a session through to the end.
        if (!KEYED_PROVIDERS.includes(provider)) {
            throw new BadRequestException(`${provider} does not take an API key here`);
        }
        const secretKey = SECRET_KEY_BY_PROVIDER[provider];
        if (!secretKey) {
            throw new BadRequestException(`${provider} does not take an API key`);
        }
        return secretKey;
    }

    /**
     * A model name, or `undefined` for «no choice».
     *
     * Length and emptiness only. The catalogue is curated and not exhaustive, so
     * rejecting an id merely because we do not know it would be worse than the
     * typo it would catch — the provider, or the PC, says so on first use.
     */
    private validateModelName(raw: string | null | undefined): string | undefined {
        const model = typeof raw === 'string' ? raw.trim() : '';
        if (!model) return undefined;
        if (model.length > MODEL_MAX_CHARS) {
            throw new BadRequestException(`Model name too long (max ${MODEL_MAX_CHARS})`);
        }
        return model;
    }

    /**
     * Whether this table can actually reach a provider.
     *
     * `ollama` is the table's own hardware and takes no key, so it is always
     * reachable; everything else needs a credential in the vault. Checked on
     * write only: a configuration saved before a key was removed must stay
     * readable, or the settings page would fail to load exactly when someone
     * comes to fix it.
     */
    private hasCredentialFor(guildId: string, provider: AIProvider): boolean {
        const secretKey = SECRET_KEY_BY_PROVIDER[provider];
        if (!secretKey) return true;
        return tenantSecretsRepository.getMeta({ scope: 'guild', scopeId: guildId, secretKey }) !== undefined;
    }

    /** `tier` is null for a choice that is not one of the two groups, like the image model. */
    private validateChoice(guildId: string, choice: TierChoiceDto, tier: AiTier | null): TierChoiceDto {
        if (!AI_PROVIDERS.includes(choice.provider)) {
            throw new BadRequestException(`Unknown provider: ${choice.provider}`);
        }
        // Saving a model on a provider with no key produces a table that looks
        // configured and stops mid-session. The UI already greys those options
        // out; this is what makes it true rather than merely displayed.
        if (!this.hasCredentialFor(guildId, choice.provider)) {
            throw new BadRequestException(
                `No API key is configured for ${choice.provider}: add the key before choosing its models`,
            );
        }
        const model = typeof choice.model === 'string' ? choice.model.trim() : '';
        if (!model) {
            throw new BadRequestException(
                tier ? `A model is required for the ${tier} group` : 'A model is required',
            );
        }
        if (model.length > MODEL_MAX_CHARS) {
            throw new BadRequestException(`Model name too long (max ${MODEL_MAX_CHARS})`);
        }
        // The model is not validated against the catalogue: it is curated, not
        // exhaustive, and providers publish new ones every month. Rejecting a valid
        // id just because we do not know it would be worse than the risk of a typo,
        // which the provider reports on first use anyway.
        return { provider: choice.provider, model };
    }
}
