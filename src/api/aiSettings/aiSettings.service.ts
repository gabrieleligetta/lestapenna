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
import { EMBEDDING_MODELS, tenantOllamaUrl } from '../../bard/ai/embeddings';
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
import { listWakeMethods, wakeAndWait, wakeMethod } from '../../services/wake';
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
            else if (choice !== undefined) tiers[tier] = this.validateChoice(choice, tier);
        }

        // The image model is a phase override, not a group: there is one image
        // select, and expanding a "group" of one would be ceremony for nothing.
        const phases = { ...current.phases };
        if ('image' in patch) {
            if (patch.image === null) delete phases.image;
            else if (patch.image !== undefined) phases.image = this.validateChoice(patch.image, null);
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
        if (!secretVault.isEnabled()) {
            throw new ServiceUnavailableException('The secret vault is not configured on this instance');
        }
        const trimmed = token?.trim();
        if (!trimmed) throw new BadRequestException('The token must not be empty');

        tenantSecretsRepository.put(
            { scope: 'guild', scopeId: guildId, secretKey: 'remoteWhisper.authToken' },
            trimmed,
            actorUserId,
        );
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
        const resolved = resolveTranscription({ guildId });
        if (resolved.engine !== 'remote') {
            return {
                status: 'NOT_CONFIGURED',
                detail: 'Nessun PC configurato per questo tavolo.',
            };
        }

        try {
            await axios.get(`${resolved.remote.url}/health`, {
                timeout: resolved.remote.connectTimeoutMs,
                headers: resolved.remote.authHeaders,
            });
            return { status: 'OK', detail: null };
        } catch (error: any) {
            if (error?.response?.status === 401 || error?.response?.status === 403) {
                return { status: 'UNAUTHORIZED', detail: 'Il PC ha rifiutato il token.' };
            }
            return { status: 'UNREACHABLE', detail: redactKeyLike(String(error?.message ?? '')).slice(0, 300) };
        }
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
    async wakeTranscription(guildId: string): Promise<TranscriptionProbeDto> {
        const resolved = resolveTranscription({ guildId });
        if (resolved.engine !== 'remote' || !resolved.remote.wake.macAddress) {
            return { status: 'NOT_CONFIGURED', detail: 'Nessun MAC configurato: non c\'è nulla da svegliare.' };
        }

        const result = await wakeAndWait({
            macAddress: resolved.remote.wake.macAddress,
            method: resolved.remote.wake.method,
            options: resolved.remote.wake.options,
            secrets: resolved.remote.wake.secrets,
            healthUrl: `${resolved.remote.url}/health`,
            healthHeaders: resolved.remote.authHeaders,
            bootTimeoutMs: resolved.remote.wake.bootTimeoutMs,
            pollIntervalMs: resolved.remote.wake.pollIntervalMs,
        });

        return result.success
            ? { status: 'OK', detail: null }
            : { status: 'UNREACHABLE', detail: 'Il PC non ha risposto entro il tempo di avvio.' };
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
        return Object.entries(stored?.phases ?? {}).map(([phase, choice]) => ({
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
            if (!CONFIGURABLE_PHASES.includes(override.phase)) {
                throw new BadRequestException(`Unknown phase: ${override.phase}`);
            }
            phases[override.phase] = this.validateChoice(
                { provider: override.provider, model: override.model }, 'fast',
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

    /** `tier` is null for a choice that is not one of the two groups, like the image model. */
    private validateChoice(choice: TierChoiceDto, tier: AiTier | null): TierChoiceDto {
        if (!AI_PROVIDERS.includes(choice.provider)) {
            throw new BadRequestException(`Unknown provider: ${choice.provider}`);
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
