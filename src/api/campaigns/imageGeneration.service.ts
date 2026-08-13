import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/types';
import { phaseConfigFor } from '../../bard/config';
import { getImageClient } from '../../bard/config';
import { scopeForCampaign } from '../../bard/ai/scope';
import { generateImage, ImageRefusedError } from '../../bard/llm/image';
import {
    AppearanceDossierRequiredError,
    buildPortraitPrompt,
    describeFromDossier,
    MAX_USER_PROMPT_CHARS,
    NothingToDrawError,
} from '../../bard/imagePrompt';
import { transformImageVariants } from '../../utils/imageTransform';
import {
    calculateActualAiCost,
    buildEuroCostSnapshot,
    getUsdEurRate,
    usdToEur,
    UNAVAILABLE_EXCHANGE_RATE,
} from '../../services/aiCostTransparency';
import {
    costUsdFor,
    imageCostUsdFor,
    resolvePricingFor,
    hasKnownPrice,
} from '../../services/pricingSource';
import {
    ActiveJobExistsError,
    aiJobRepository,
    parseAiJobParams,
    type AiJobRow,
} from '../../db/repositories/AiJobRepository';
import { aiJobEvents } from '../../services/aiJobs/events';
import { AiJobFailure, type AiJobHandler, type AiJobOutcome } from '../../services/aiJobs/types';
import { aiUsageRepository } from '../../db/repositories/AiUsageRepository';
import { campaignRepository } from '../../db/repositories/CampaignRepository';
import { IMAGE_GENERATION_MODES, type ImageGenerationMode } from '../../db/types';
import { logger } from '../../utils/logger';
import { EntityMediaService } from './entityMedia.service';
import { EntityMediaStorage, type EntityMediaReadResult } from '../../services/entityMediaStorage';
import {
    ReferenceImagesService,
    ReferenceUnavailableError,
} from './referenceImages.service';
import { AiJobsService, toAiJobDto } from './aiJobs.service';
import { subjectFacts } from '../../bard/entityFacts';
import { exchangeRateDto } from './dto/cost.dto';
import type { AiJobAcceptedDto, AiJobDto } from './dto/aiJob.dto';
import type {
    GenerateEntityImageDto,
    ImageGenerationEstimateDto,
    ReferenceCandidateDto,
} from './dto/imageGeneration.dto';
import type { EntityImageDto } from './dto/media.dto';
import {
    ReferenceContractError,
    normalizeReferenceSelections,
    validateReferenceCapabilities,
    type ReferenceManifestEntry,
} from '../../bard/imageReferences';

const log = logger('ImageGeneration');

/** Everything the drawing needs, written down while the request is still here. */
interface ImageJobParams {
    rawType: string;
    entityId: string;
    mode: ImageGenerationMode;
    userPrompt: string | null;
    shot: GenerateEntityImageDto['shot'];
    references: ReferenceManifestEntry[];
    /** Jobs queued by the previous API shape remain readable during rollout. */
    referenceIds?: string[];
}

/** What the finished job says about the picture it produced. */
interface ImageJobResult {
    width: number;
    height: number;
    mode: ImageGenerationMode;
    prompt: string;
    sources: Array<'dossier' | 'sheet' | 'rag' | 'user'>;
    references: ReferenceManifestEntry[];
    shot: GenerateEntityImageDto['shot'];
    user_prompt: string | null;
    media_id?: string;
}

/**
 * Generating an entity's picture, and paying for it.
 *
 * **Why it is a job and no longer an awaited call.** The provider is paid when
 * the call is made, not when the result is accepted — so a dropped connection, a
 * closed tab or a redeploy used to throw away something the table had already
 * been charged for, and left nowhere to read that it had happened. Now the row
 * is written first, the drawing happens outside the request, and the bytes go to
 * the bucket the moment the provider answers. What is paid for is safe before
 * anything else is attempted with it.
 *
 * **Why it is metered so carefully.** One picture costs several hundred chat
 * messages. Everything here that touches money follows the rule the cost layer
 * is built on: an unknown price is `null` and never `0`, because the worst place
 * to round an unknown down is the most expensive click in the product.
 */
@Injectable()
export class ImageGenerationService implements AiJobHandler {
    private readonly storage = new EntityMediaStorage();

    constructor(
        private readonly media: EntityMediaService,
        private readonly references: ReferenceImagesService,
        private readonly jobs: AiJobsService,
    ) {}

    /**
     * What it will cost, before anything is spent.
     *
     * Deliberately builds no client and touches no credential — the same choice
     * `$ask`'s estimate makes — so a table that has not configured a key yet can
     * still find out what the action would cost them.
     */
    async estimate(
        request: AuthenticatedRequest,
        rawType: string,
        entityId: string,
        draft: ImageGenerationMode | GenerateEntityImageDto,
    ): Promise<ImageGenerationEstimateDto> {
        const campaignId = request.campaignId!;
        const entity = this.media.resolveEntity(campaignId, rawType, entityId);
        this.media.assertCanWrite(request, entity);

        const body = typeof draft === 'string'
            ? { mode: draft } as GenerateEntityImageDto
            : draft;
        const mode = this.validateMode(body.mode);
        // The legacy GET estimate has no body and therefore cannot carry the
        // prompt. It remains a coarse mode-only quote during rollout; the SPA
        // uses the POST draft estimate, which validates and prices the real job.
        if (typeof draft !== 'string') this.validateUserPrompt(body.prompt, mode);
        this.assertDossier(campaignId, entity.entityType, entityId, mode);
        const references = this.referenceManifest(campaignId, body);

        const scope = scopeForCampaign(campaignId);
        const image = phaseConfigFor('image', scope);
        try {
            validateReferenceCapabilities(image.provider, image.model, references);
        } catch (error) {
            if (error instanceof ReferenceContractError) throw new BadRequestException(error.message);
            throw error;
        }
        const imagePricing = resolvePricingFor(image.provider, image.model, scope);
        const imageCostUsd = imageCostUsdFor(imagePricing, image.model, 1);
        // A dossier is assembled locally, so none of the three modes pays a
        // text model. Reference inputs can carry their own token charge. This
        // is a forecast (actual usage comes from the provider), and becomes
        // unknown rather than zero when no input-token rate is available.
        const referenceInputUsd = references.length === 0
            ? 0
            : costUsdFor(imagePricing, {
                input: references.length * REFERENCE_INPUT_TOKEN_FORECAST,
                output: 0,
                cached: 0,
            });
        const referenceInputCostIncluded = references.length === 0 || referenceInputUsd !== null;
        const totalUsd = imageCostUsd === null || referenceInputUsd === null
            ? null
            : imageCostUsd + referenceInputUsd;

        const exchangeRate = totalUsd === null ? UNAVAILABLE_EXCHANGE_RATE : await getUsdEurRate();

        return {
            mode,
            provider: image.provider,
            model: image.model,
            text_provider: null,
            text_model: null,
            billable: true,
            pricing_available: totalUsd !== null && hasKnownPrice(imagePricing.source),
            estimated_cost_usd: totalUsd,
            estimated_cost_eur: totalUsd === null ? null : usdToEur(totalUsd, exchangeRate),
            reference_count: references.length,
            reference_input_cost_included: referenceInputCostIncluded,
            exchange_rate: exchangeRateDto(exchangeRate),
        };
    }

    /** What this generation could draw from, for the person to choose among. */
    referenceCandidates(
        request: AuthenticatedRequest,
        rawType: string,
        entityId: string,
    ): ReferenceCandidateDto[] {
        const campaignId = request.campaignId!;
        const entity = this.media.resolveEntity(campaignId, rawType, entityId);
        this.media.assertCanWrite(request, entity);
        const subject = subjectFacts(campaignId, entity.entityType, entityId);
        return this.references.candidates(
            campaignId,
            entity.entityType,
            entity.entityKey,
            subject?.factions ?? [],
        );
    }

    /**
     * Takes the request and hands back a job.
     *
     * Nothing paid happens here, and nothing awaited: by the time this returns,
     * the work is a row that outlives the connection that asked for it.
     */
    enqueue(
        request: AuthenticatedRequest,
        rawType: string,
        entityId: string,
        body: GenerateEntityImageDto,
    ): AiJobAcceptedDto {
        const campaignId = request.campaignId!;
        const entity = this.media.resolveEntity(campaignId, rawType, entityId);
        this.media.assertCanWrite(request, entity);

        if (!this.media.storageEnabled()) {
            // Refused now rather than after the provider has been paid: there
            // would be nowhere to put the result.
            throw new ServiceUnavailableException('Entity media storage is not configured');
        }

        const mode = this.validateMode(body.mode);
        const userPrompt = this.validateUserPrompt(body.prompt, mode);
        this.assertDossier(campaignId, entity.entityType, entityId, mode);
        const references = this.referenceManifest(campaignId, body);
        const configured = phaseConfigFor('image', scopeForCampaign(campaignId));
        try {
            validateReferenceCapabilities(configured.provider, configured.model, references);
        } catch (error) {
            if (error instanceof ReferenceContractError) {
                throw new BadRequestException(error.message);
            }
            throw error;
        }
        const params: ImageJobParams = {
            rawType,
            entityId,
            mode,
            userPrompt,
            shot: body.shot ?? null,
            references,
        };

        try {
            const job = aiJobRepository.enqueue({
                campaignId,
                kind: 'image',
                // The public short id, not `entity.entityKey`: that one is the
                // internal row id for three types out of four, and this key is
                // what the URL, the prompt builder and the person all use.
                targetType: entity.entityType,
                targetKey: entityId,
                targetLabel: subjectFacts(campaignId, entity.entityType, entityId)?.name ?? null,
                requestedBy: request.webSession.discordUserId,
                params,
            });
            try {
                this.references.attachScratch(campaignId, job.id, references);
            } catch (error) {
                aiJobRepository.markFailed(
                    job.id,
                    'reference',
                    (error as Error).message,
                );
                throw new BadRequestException((error as Error).message);
            }
            aiJobEvents.emitEnqueued();
            return { job_id: job.id, status: job.status };
        } catch (error) {
            if (error instanceof ActiveJobExistsError) {
                throw new ConflictException('A picture for this entity is already being generated');
            }
            throw error;
        }
    }

    /**
     * Draws the picture, outside the request that asked for it.
     *
     * The order of the last three steps is the feature: the provider answers,
     * the spend is recorded, and the bytes are written to the bucket **before**
     * anything else can go wrong. Everything after that point can fail and be
     * retried for free; everything before it is somebody's money.
     */
    async run(job: AiJobRow): Promise<AiJobOutcome> {
        const params = parseAiJobParams<ImageJobParams>(job);
        if (!params) throw new AiJobFailure('internal', 'This job has no readable request');

        const campaignId = job.campaign_id;
        const entity = this.media.resolveEntity(campaignId, params.rawType, params.entityId);
        const referenceManifest = params.references ?? this.references.snapshotChosen(
            campaignId,
            (params.referenceIds ?? []).map((id, index) => ({ id, priority: index + 1 })),
        );

        let brief;
        try {
            brief = await buildPortraitPrompt({
                campaignId,
                entityType: entity.entityType,
                entityId: params.entityId,
                mode: params.mode,
                userPrompt: params.userPrompt,
                shot: params.shot ?? null,
            });
        } catch (error) {
            await this.references.releaseScratch(campaignId, referenceManifest);
            if (error instanceof NothingToDrawError) {
                throw new AiJobFailure('refused', error.message);
            }
            throw error;
        }

        // Only what was asked for. Each reference is input tokens on the table's
        // own account, so they travel because somebody ticked them, never
        // because the server thought they might help.
        const configured = phaseConfigFor('image', scopeForCampaign(campaignId));
        try {
            validateReferenceCapabilities(configured.provider, configured.model, referenceManifest);
        } catch (error) {
            await this.references.releaseScratch(campaignId, referenceManifest);
            if (error instanceof ReferenceContractError) {
                throw new AiJobFailure('reference', error.message);
            }
            throw error;
        }

        let references;
        try {
            references = await this.references.collectChosen(campaignId, referenceManifest, job.id);
        } catch (error) {
            await this.references.releaseScratch(campaignId, referenceManifest);
            if (error instanceof ReferenceUnavailableError) {
                throw new AiJobFailure('reference', error.message);
            }
            throw error;
        }

        let drawn;
        try {
            drawn = await generateImage({
                route: await getImageClient(scopeForCampaign(campaignId)),
                prompt: brief.prompt,
                shape: brief.shape,
                referenceImages: references,
            });
        } catch (error) {
            if (error instanceof ImageRefusedError) {
                // Nothing is wrong with the key: the prompt has to change, and
                // saying so is what stops someone auditing their billing page.
                throw new AiJobFailure('refused', error.message);
            }
            throw error;
        } finally {
            // A one-time reference has completed its only job whether the
            // provider drew or refused. Its metadata remains in the job's
            // immutable manifest, while the private bytes are removed.
            await this.references.releaseScratch(campaignId, referenceManifest);
        }

        const cost = await this.recordSpend(job, campaignId, drawn, brief.textUsage);

        try {
            // Transcoded now, not at acceptance: the variants are what gets
            // stored, and finding out here that the provider returned something
            // undecodable is better than finding out after a "keep it".
            const variants = await transformImageVariants(drawn.bytes);
            const guildId = campaignRepository.getCampaignById(campaignId)?.guild_id ?? 'unknown';
            const prefix = `ai-jobs/${guildId}/${campaignId}/${job.id}`;
            const originalKey = `${prefix}/original.webp`;
            const displayKey = `${prefix}/display.webp`;

            await this.storage.put(originalKey, drawn.bytes, 'application/octet-stream');
            await this.storage.put(displayKey, variants.display);

            const result: ImageJobResult = {
                width: variants.width,
                height: variants.height,
                mode: params.mode,
                prompt: brief.prompt,
                sources: brief.sources,
                references: referenceManifest,
                shot: params.shot ?? null,
                user_prompt: params.userPrompt,
            };
            return { status: 'awaiting_review', originalKey, displayKey, summary: result };
        } catch (error) {
            // The picture exists and has been paid for. Saying "storage" rather
            // than letting this look like a provider failure is the difference
            // between "try again" and "your key is broken".
            log.error(`Could not store the picture for job ${job.id} (cost ${cost.cost_usd ?? 'unknown'})`, error as Error);
            throw new AiJobFailure('storage', 'The picture was drawn but could not be stored');
        }
    }

    /**
     * Keeps a generated picture, through the very same path an upload takes.
     *
     * Not a second write path: `EntityMediaService.upload` already validates,
     * transcodes, stores both variants atomically and sweeps the previous
     * objects. Reimplementing that here for the sake of one different column is
     * how two persistence paths start to disagree.
     */
    async commit(
        request: AuthenticatedRequest,
        rawType: string,
        entityId: string,
        jobId: string,
    ): Promise<EntityImageDto> {
        const entity = this.media.resolveEntity(request.campaignId!, rawType, entityId);
        this.media.assertCanWrite(request, entity);

        const job = this.jobs.requireDecidable(request, jobId);
        if (job.status !== 'awaiting_review' || !job.result_original_key) {
            throw new NotFoundException('That picture is no longer waiting for a decision');
        }
        if (job.target_key !== entityId) {
            throw new NotFoundException('That picture belongs to another entity');
        }

        const original = await this.storage.getBuffer(job.result_original_key);
        if (!original) {
            throw new NotFoundException('That picture is no longer available — generate it again');
        }

        const params = parseAiJobParams<ImageJobParams>(job);
        const result = job.result_json ? (JSON.parse(job.result_json) as ImageJobResult) : null;
        const stored = await this.media.upload(
            request,
            rawType,
            entityId,
            original,
            {},
            {
                source: 'ai',
                mode: params?.mode ?? 'auto',
                prompt: result?.prompt ?? null,
                userPrompt: params?.userPrompt ?? null,
                request: params ? {
                    mode: params.mode,
                    prompt: params.userPrompt,
                    shot: params.shot ?? null,
                    references: result?.references ?? params.references ?? [],
                } : null,
            },
        );

        aiJobRepository.markSucceeded(job.id, { ...(result ?? {}), media_id: stored.id });
        await this.dropArtifacts(job);
        this.announce(job.id);
        return stored;
    }

    /** Refuses a picture. The money is already gone; the bytes need not linger. */
    async discard(request: AuthenticatedRequest, jobId: string): Promise<void> {
        const job = this.jobs.requireDecidable(request, jobId);
        aiJobRepository.markDiscarded(job.id);
        await this.dropArtifacts(job);
        this.announce(job.id);
    }

    /** The picture itself, while it waits for a decision. */
    async readPreview(request: AuthenticatedRequest, jobId: string): Promise<EntityMediaReadResult> {
        const job = this.jobs.requireVisible(request, jobId);
        if (!job.result_display_key) {
            throw new NotFoundException('That job has no picture to show');
        }
        const found = await this.storage.read(job.result_display_key);
        if (!found) throw new NotFoundException('That picture is no longer available');
        return found;
    }

    /** The job this entity currently has in flight or awaiting a decision, if any. */
    pending(request: AuthenticatedRequest, rawType: string, entityId: string): AiJobDto | null {
        const campaignId = request.campaignId!;
        const entity = this.media.resolveEntity(campaignId, rawType, entityId);
        this.media.assertCanWrite(request, entity);

        const open = aiJobRepository.listForCampaign(campaignId, {
            statuses: ['queued', 'running', 'awaiting_review'],
            limit: 50,
        }).find(row => row.kind === 'image' && row.target_key === entityId);
        return open ? toAiJobDto(open) : null;
    }

    private async dropArtifacts(job: AiJobRow): Promise<void> {
        for (const key of [job.result_original_key, job.result_display_key]) {
            if (!key) continue;
            // Best effort: a decision already taken must not fail because a
            // bucket was slow. The sweeper picks up whatever is left.
            await this.storage.delete(key).catch(error =>
                log.warn(`Could not delete ${key}: ${(error as Error).message}`));
        }
    }

    private announce(jobId: string): void {
        const updated = aiJobRepository.getById(jobId);
        if (updated) aiJobEvents.emitChanged(updated);
    }

    private referenceManifest(
        campaignId: number,
        body: Pick<GenerateEntityImageDto, 'references' | 'reference_ids'>,
    ): ReferenceManifestEntry[] {
        try {
            const selections = normalizeReferenceSelections(body.references, body.reference_ids);
            return this.references.snapshotChosen(campaignId, selections);
        } catch (error) {
            if (error instanceof ReferenceContractError || error instanceof ReferenceUnavailableError) {
                throw new BadRequestException(error.message);
            }
            throw error;
        }
    }

    private assertDossier(
        campaignId: number,
        entityType: Parameters<typeof describeFromDossier>[1],
        entityId: string,
        mode: ImageGenerationMode,
    ): void {
        if (mode === 'prompt') return;
        if (!describeFromDossier(campaignId, entityType, entityId)) {
            throw new BadRequestException(new AppearanceDossierRequiredError().message);
        }
    }

    private validateMode(raw: unknown): ImageGenerationMode {
        if (typeof raw !== 'string' || !IMAGE_GENERATION_MODES.includes(raw as ImageGenerationMode)) {
            throw new BadRequestException(
                `mode must be one of: ${IMAGE_GENERATION_MODES.join(', ')}`,
            );
        }
        return raw as ImageGenerationMode;
    }

    private validateUserPrompt(raw: unknown, mode: ImageGenerationMode): string | null {
        if (raw === undefined || raw === null) {
            if (mode === 'auto') return null;
            throw new BadRequestException('This mode needs a description to work from');
        }
        if (typeof raw !== 'string') throw new BadRequestException('prompt must be a string');

        const trimmed = raw.trim();
        if (trimmed.length > MAX_USER_PROMPT_CHARS) {
            throw new BadRequestException(`prompt must be at most ${MAX_USER_PROMPT_CHARS} characters`);
        }
        if (trimmed === '') {
            if (mode === 'auto') return null;
            throw new BadRequestException('This mode needs a description to work from');
        }
        return trimmed;
    }

    /**
     * Writes what was actually spent to `ai_usage_log`.
     *
     * The picture's fixed output price and any reported reference-input tokens
     * are combined under the image phase. `textUsage` stays readable only for
     * jobs queued before dossier assembly became local.
     *
     * The job is stamped with the run id **first**, before either write can
     * fail: from that moment the register says the provider was paid, which is
     * the one fact that must survive even when the ledger write does not.
     */
    private async recordSpend(
        job: AiJobRow,
        campaignId: number,
        drawn: { provider: string; model: string; usage: { input: number; output: number; cached: number } },
        textUsage: { input: number; output: number; cached: number } | null,
    ): Promise<{ cost_usd: number | null; cost_eur: number | null; pricing_available: boolean }> {
        const scope = scopeForCampaign(campaignId);
        const guildId = campaignRepository.getCampaignById(campaignId)?.guild_id ?? null;
        const runId = `AIJOB:${job.id}`;

        const imagePricing = resolvePricingFor(drawn.provider as never, drawn.model, scope);
        const imageOutputUsd = imageCostUsdFor(imagePricing, drawn.model, 1);
        const imageInputUsd = drawn.usage.input === 0
            ? 0
            : costUsdFor(imagePricing, {
                input: Math.max(0, drawn.usage.input - drawn.usage.cached),
                output: 0,
                cached: drawn.usage.cached,
            });
        const imageUsd = imageOutputUsd === null || imageInputUsd === null
            ? null
            : imageOutputUsd + imageInputUsd;

        aiJobRepository.recordSpend(job.id, {
            usageRunId: runId,
            provider: drawn.provider,
            model: drawn.model,
            pricingAvailable: imageUsd !== null,
        });

        const text = textUsage ? phaseConfigFor('metadata', scope) : null;
        const textCost = text && textUsage
            ? calculateActualAiCost(text.provider, text.model, textUsage, scope)
            : null;

        const totalUsd = imageUsd === null ? null : imageUsd + (textCost?.costUsd ?? 0);
        const exchangeRate = totalUsd === null ? UNAVAILABLE_EXCHANGE_RATE : await getUsdEurRate();
        const euro = totalUsd === null ? null : buildEuroCostSnapshot(totalUsd, exchangeRate);

        const entries = [] as Parameters<typeof aiUsageRepository.logSessionUsage>[3];
        if (imageUsd !== null) {
            const imageEuro = buildEuroCostSnapshot(imageUsd, exchangeRate);
            entries.push({
                phase: 'image',
                provider: drawn.provider,
                model: drawn.model,
                inputTokens: drawn.usage.input,
                outputTokens: drawn.usage.output,
                cachedInputTokens: drawn.usage.cached,
                costUSD: imageUsd,
                costEUR: imageEuro.costEur ?? undefined,
                usdPerEur: imageEuro.usdPerEur ?? undefined,
                exchangeRateSource: imageEuro.exchangeRateSource,
                exchangeRateDate: imageEuro.exchangeRateDate ?? undefined,
                exchangeRateFetchedAt: imageEuro.exchangeRateFetchedAt ?? undefined,
                pricingSource: imagePricing.source,
            });
        }
        if (text && textUsage && textCost?.costUsd !== null && textCost !== null) {
            const textEuro = buildEuroCostSnapshot(textCost.costUsd!, exchangeRate);
            entries.push({
                phase: 'image-prompt',
                provider: text.provider,
                model: text.model,
                inputTokens: textUsage.input,
                outputTokens: textUsage.output,
                cachedInputTokens: textUsage.cached,
                inputPricePerMillion: textCost.inputPricePerMillion ?? undefined,
                outputPricePerMillion: textCost.outputPricePerMillion ?? undefined,
                costUSD: textCost.costUsd!,
                costEUR: textEuro.costEur ?? undefined,
                usdPerEur: textEuro.usdPerEur ?? undefined,
                exchangeRateSource: textEuro.exchangeRateSource,
                exchangeRateDate: textEuro.exchangeRateDate ?? undefined,
                exchangeRateFetchedAt: textEuro.exchangeRateFetchedAt ?? undefined,
                pricingSource: textCost.pricingSource,
            });
        }

        if (entries.length > 0) {
            try {
                aiUsageRepository.logSessionUsage(runId, guildId, campaignId, entries);
            } catch (error) {
                // The picture exists and has been paid for; losing the ledger
                // row must not lose the picture too.
                log.warn(`Could not record the spend for ${runId}: ${(error as Error).message}`);
            }
        }

        return {
            cost_usd: totalUsd,
            cost_eur: euro?.costEur ?? null,
            pricing_available: totalUsd !== null,
        };
    }
}

/** Conservative forecast only; actual input tokens always come from the provider. */
const REFERENCE_INPUT_TOKEN_FORECAST = 1_500;
