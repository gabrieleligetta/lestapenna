import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/types';
import { phaseConfigFor } from '../../bard/config';
import { scopeForCampaign } from '../../bard/ai/scope';
import {
    APPEARANCE_FIELDS,
    APPEARANCE_MAX_TOOL_CALLS,
    APPEARANCE_MAX_TURNS,
    PERSONALITY_FIELDS,
    prepareAppearanceAnalysis,
    runEntityAppearanceAgent,
    SubjectNotFoundError,
} from '../../bard/agent/entityAppearance';
import { subjectFacts, SUBJECT_KIND, type SubjectKind } from '../../bard/entityFacts';
import {
    buildEuroCostSnapshot,
    calculateActualAiCost,
    estimateAgentCost,
    getUsdEurRate,
    UNAVAILABLE_EXCHANGE_RATE,
    usdRangeToEur,
} from '../../services/aiCostTransparency';
import { aiUsageRepository } from '../../db/repositories/AiUsageRepository';
import {
    ActiveJobExistsError,
    aiJobRepository,
    parseAiJobParams,
    type AiJobRow,
} from '../../db/repositories/AiJobRepository';
import { aiJobEvents } from '../../services/aiJobs/events';
import { AiJobFailure, type AiJobHandler, type AiJobOutcome } from '../../services/aiJobs/types';
import { campaignRepository } from '../../db/repositories/CampaignRepository';
import {
    entityProfileRepository,
    parseAppearance,
    parseEvidence,
    parseManualFields,
    parsePersonality,
} from '../../db/repositories/EntityProfileRepository';
import type { EntityProfileEntry } from '../../db/types';
import { logger } from '../../utils/logger';
import { EntityMediaService } from './entityMedia.service';
import { exchangeRateDto } from './dto/cost.dto';
import type {
    EntityProfileDto,
    EntityProfileEstimateDto,
    UpdateEntityProfileDto,
} from './dto/entityProfile.dto';
import type { AiJobAcceptedDto } from './dto/aiJob.dto';

const log = logger('EntityProfile');

/**
 * The result of one tool call, as the estimator should assume it.
 *
 * A transcript passage is the biggest thing these tools return, and the
 * estimate has to assume the expensive case: quoting the cheap one and
 * charging the dear one is the failure mode that matters here.
 */
const APPEARANCE_MAX_TOOL_RESULT_CHARS = 4200;

/** The longest hand-written correction the sheet accepts. Prose, not an essay. */
const MAX_MANUAL_TEXT_CHARS = 2000;

/**
 * Establishing, correcting and paying for an entity's appearance dossier.
 *
 * The analysis is the second paid action in this feature and the more expensive
 * one to get wrong, because its output is stored and then drawn from over and
 * over. Everything here therefore follows the same rule as the generation: an
 * unknown price is `null` and never `0`, the estimate holds no credential, and
 * what is actually spent is written to `ai_usage_log`.
 */
@Injectable()
export class EntityProfileService implements AiJobHandler {
    constructor(private readonly media: EntityMediaService) {}

    /**
     * The dossier, always — an empty one for a subject nobody has analysed.
     *
     * It carries the vocabulary of fields for this kind of subject, so the sheet
     * can offer a form to fill in by hand without a second copy of that list
     * drifting in the front end. Writing the dossier yourself is the free path
     * through this feature, and it needs to work before any AI has run.
     */
    get(request: AuthenticatedRequest, rawType: string, entityId: string): EntityProfileDto {
        const campaignId = request.campaignId!;
        const entity = this.media.resolveEntity(campaignId, rawType, entityId);
        const entry = entityProfileRepository.getForEntity(campaignId, entity.entityType, entityId);
        const kind = SUBJECT_KIND[entity.entityType];
        return entry ? toProfileDto(entry, kind) : emptyProfileDto(kind);
    }

    /**
     * What an analysis would cost, before anything is spent.
     *
     * Builds no client and reads no credential, like every other estimate in
     * this app: a table that has not configured a key must still be able to find
     * out the price of the button.
     */
    async estimate(
        request: AuthenticatedRequest,
        rawType: string,
        entityId: string,
    ): Promise<EntityProfileEstimateDto> {
        const campaignId = request.campaignId!;
        const entity = this.media.resolveEntity(campaignId, rawType, entityId);
        this.media.assertCanWrite(request, entity);

        const analyst = phaseConfigFor('analyst', scopeForCampaign(campaignId));
        const prepared = this.prepare(campaignId, rawType, entityId);

        const estimate = estimateAgentCost({
            provider: analyst.provider,
            model: analyst.model,
            systemPromptChars: prepared.systemPrompt.length,
            userPromptChars: prepared.userPrompt.length,
            toolSchemaChars: JSON.stringify(prepared.tools.map(tool => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            }))).length,
            // One subject, always: this analysis is about a single entity, and
            // the output it produces is sized accordingly.
            subjectCount: 1,
            maxTurns: APPEARANCE_MAX_TURNS,
            maxToolCalls: APPEARANCE_MAX_TOOL_CALLS,
            maxToolResultChars: APPEARANCE_MAX_TOOL_RESULT_CHARS,
        });

        const exchangeRate = estimate.billable && estimate.costUsd
            ? await getUsdEurRate()
            : UNAVAILABLE_EXCHANGE_RATE;

        return {
            provider: analyst.provider,
            model: analyst.model,
            billable: estimate.billable,
            pricing_available: estimate.pricingAvailable,
            estimated_cost_usd: estimate.costUsd,
            estimated_cost_eur: usdRangeToEur(estimate.costUsd, exchangeRate),
            exchange_rate: exchangeRateDto(exchangeRate),
        };
    }

    /**
     * Accepts the request to analyse, and hands back a job.
     *
     * The agent runs outside this request — up to six turns of tool calls, all
     * of them on the table's account — so what returns here is a row that
     * outlives the connection rather than a result somebody has to stay
     * connected for.
     */
    enqueue(
        request: AuthenticatedRequest,
        rawType: string,
        entityId: string,
    ): AiJobAcceptedDto {
        const campaignId = request.campaignId!;
        const entity = this.media.resolveEntity(campaignId, rawType, entityId);
        this.media.assertCanWrite(request, entity);

        try {
            const job = aiJobRepository.enqueue({
                campaignId,
                kind: 'appearance',
                targetType: entity.entityType,
                targetKey: entityId,
                targetLabel: subjectFacts(campaignId, entity.entityType, entityId)?.name ?? null,
                requestedBy: request.webSession.discordUserId,
                params: { rawType, entityId },
            });
            aiJobEvents.emitEnqueued();
            return { job_id: job.id, status: job.status };
        } catch (error) {
            if (error instanceof ActiveJobExistsError) {
                throw new ConflictException('This entity is already being analysed');
            }
            throw error;
        }
    }

    /** Runs the analysis, stores what survives it, and records the spend. */
    async run(job: AiJobRow): Promise<AiJobOutcome> {
        const params = parseAiJobParams<{ rawType: string; entityId: string }>(job);
        if (!params) throw new AiJobFailure('internal', 'This job has no readable request');

        const campaignId = job.campaign_id;
        const entity = this.media.resolveEntity(campaignId, params.rawType, params.entityId);

        let result;
        try {
            result = await runEntityAppearanceAgent({
                campaignId,
                entityType: entity.entityType,
                entityId: params.entityId,
            });
        } catch (error) {
            if (error instanceof SubjectNotFoundError) {
                throw new AiJobFailure('refused', error.message);
            }
            throw error;
        }

        const { saved, keptFields } = entityProfileRepository.upsert({
            campaign_id: campaignId,
            entity_type: entity.entityType,
            entity_key: params.entityId,
            appearance: result.appearance,
            personality: result.personality,
            evidence: result.evidence,
            confidence: result.confidence,
            provider: result.provider,
            model: result.model,
            isManual: false,
        });

        await this.recordSpend(job, campaignId, result.provider, result.model, result.tokens);

        if (keptFields.length > 0) {
            // Not a failure: the run filled everything else and stepped around
            // what a person owns. Reporting it is how they learn the two are not
            // fighting over the same record.
            log.info(`Analysis for ${params.rawType} ${params.entityId} kept ${keptFields.length} hand-written field(s)`);
        }

        return {
            status: 'succeeded',
            summary: {
                not_recorded: result.notRecorded,
                kept_fields: keptFields,
                fields: saved ? Object.keys(parseAppearance(saved) ?? {}).length : 0,
            },
        };
    }

    /**
     * Filling in the dossier by hand, field by field.
     *
     * This is the free path through the whole feature, and the one a table
     * should be able to live on: type what your character looks like and the
     * portrait is drawn from it, with no model called and nothing spent. It is
     * also the repair for what an analysis could not find — the fields it left
     * empty are exactly the ones a person can answer.
     *
     * Each field written is claimed by the person who wrote it and survives
     * every later analysis; each field cleared is released back. Ownership is
     * per field rather than per record because the person most likely to correct
     * one line is the one with the most to add, and freezing their whole dossier
     * would punish them for it.
     */
    update(
        request: AuthenticatedRequest,
        rawType: string,
        entityId: string,
        body: UpdateEntityProfileDto,
    ): EntityProfileDto {
        const campaignId = request.campaignId!;
        const entity = this.media.resolveEntity(campaignId, rawType, entityId);
        this.media.assertCanWrite(request, entity);

        const kind = SUBJECT_KIND[entity.entityType];
        const vocabulary = new Set<string>([
            ...APPEARANCE_FIELDS[kind],
            ...(kind === 'person' ? PERSONALITY_FIELDS : []),
        ]);

        const appearance: Record<string, unknown> = {};
        const personality: Record<string, unknown> = {};
        const manualFields: string[] = [];

        for (const [rawPath, rawValue] of Object.entries(body?.fields ?? {})) {
            const path = rawPath.trim();
            if (!vocabulary.has(path)) {
                throw new BadRequestException(`Unknown field for this kind of subject: ${rawPath}`);
            }
            const value = this.validateFieldValue(rawValue, path);
            manualFields.push(path.startsWith('personality.') ? path : path);
            const target = path.startsWith('personality.') ? personality : appearance;
            const key = path.startsWith('personality.') ? path.slice('personality.'.length) : path;
            writeField(target, key, value);
        }

        if (manualFields.length === 0) throw new BadRequestException('Nothing to update');

        const { saved } = entityProfileRepository.upsert({
            campaign_id: campaignId,
            entity_type: entity.entityType,
            entity_key: entityId,
            appearance: appearance as never,
            personality: personality as never,
            evidence: [],
            confidence: null,
            provider: null,
            model: null,
            isManual: true,
            manualFields,
        });

        return toProfileDto(saved!, kind);
    }

    private prepare(campaignId: number, rawType: string, entityId: string) {
        try {
            return prepareAppearanceAnalysis({
                campaignId,
                entityType: this.media.resolveEntity(campaignId, rawType, entityId).entityType,
                entityId,
            });
        } catch (error) {
            if (error instanceof SubjectNotFoundError) throw new NotFoundException(error.message);
            throw error;
        }
    }

    /**
     * One field's value: a phrase, a list of phrases, or nothing.
     *
     * Nothing is a real answer here — it releases a field back to the AI — so
     * empty is normalised rather than rejected.
     */
    private validateFieldValue(raw: unknown, field: string): string | string[] | null {
        if (raw === null || raw === undefined) return null;
        if (Array.isArray(raw)) {
            const values = raw
                .filter((item): item is string => typeof item === 'string')
                .map(item => item.trim())
                .filter(item => item !== '');
            if (values.some(item => item.length > MAX_MANUAL_TEXT_CHARS)) {
                throw new BadRequestException(`${field} entries must be at most ${MAX_MANUAL_TEXT_CHARS} characters`);
            }
            return values.length > 0 ? values : null;
        }
        if (typeof raw !== 'string') throw new BadRequestException(`${field} must be text, a list of text, or null`);
        const trimmed = raw.trim();
        if (trimmed.length > MAX_MANUAL_TEXT_CHARS) {
            throw new BadRequestException(`${field} must be at most ${MAX_MANUAL_TEXT_CHARS} characters`);
        }
        return trimmed || null;
    }

    /**
     * Writes what the analysis actually cost, at the rate it was actually billed.
     *
     * The job is stamped with the run id first, whatever the ledger does next:
     * from that moment the register says the provider was paid, which stays true
     * even for a model whose price we do not know and therefore never log.
     */
    private async recordSpend(
        job: AiJobRow,
        campaignId: number,
        provider: string,
        model: string,
        tokens: { input: number; output: number; cached?: number },
    ): Promise<{ cost_usd: number | null; cost_eur: number | null; pricing_available: boolean }> {
        const scope = scopeForCampaign(campaignId);
        const guildId = campaignRepository.getCampaignById(campaignId)?.guild_id ?? null;

        const actual = calculateActualAiCost(provider as never, model, {
            input: tokens.input,
            output: tokens.output,
            cached: tokens.cached ?? 0,
        }, scope);

        const exchangeRate = actual.costUsd === null ? UNAVAILABLE_EXCHANGE_RATE : await getUsdEurRate();
        const euro = actual.costUsd === null ? null : buildEuroCostSnapshot(actual.costUsd, exchangeRate);

        aiJobRepository.recordSpend(job.id, {
            usageRunId: `AIJOB:${job.id}`,
            provider,
            model,
            pricingAvailable: actual.costUsd !== null,
        });

        if (actual.costUsd !== null) {
            aiUsageRepository.logSessionUsage(
                `AIJOB:${job.id}`,
                guildId,
                campaignId,
                [{
                    phase: 'appearance',
                    provider,
                    model,
                    inputTokens: tokens.input,
                    outputTokens: tokens.output,
                    cachedInputTokens: tokens.cached ?? 0,
                    costUSD: actual.costUsd,
                    costEUR: euro?.costEur ?? undefined,
                    usdPerEur: euro?.usdPerEur ?? undefined,
                    exchangeRateSource: euro?.exchangeRateSource,
                    exchangeRateDate: euro?.exchangeRateDate ?? undefined,
                    exchangeRateFetchedAt: euro?.exchangeRateFetchedAt ?? undefined,
                    pricingSource: actual.pricingSource,
                }],
            );
        }

        return {
            cost_usd: actual.costUsd,
            cost_eur: euro?.costEur ?? null,
            // An unknown rate is not a free one: the UI must be able to tell
            // "we do not know" from "it cost nothing".
            pricing_available: actual.costUsd !== null,
        };
    }
}

/** The shape a subject with no dossier yet answers with: empty, and honest about it. */
function emptyProfileDto(kind: SubjectKind): EntityProfileDto {
    return {
        kind,
        fields: fieldsFor(kind),
        appearance: null,
        appearance_text: null,
        personality: null,
        personality_text: null,
        evidence: [],
        confidence: null,
        is_manual: false,
        manual_fields: [],
        provider: null,
        model: null,
        generated_at: null,
        stale_since_session_id: null,
    };
}

function fieldsFor(kind: SubjectKind): string[] {
    return [...APPEARANCE_FIELDS[kind], ...(kind === 'person' ? PERSONALITY_FIELDS : [])];
}

function writeField(target: Record<string, unknown>, path: string, value: unknown): void {
    const [head, tail] = path.split('.');
    if (!tail) {
        target[head] = value;
        return;
    }
    const nested = target[head] && typeof target[head] === 'object'
        ? target[head] as Record<string, unknown>
        : {};
    nested[tail] = value;
    target[head] = nested;
}

function toProfileDto(entry: EntityProfileEntry, kind: SubjectKind): EntityProfileDto {
    const personality = parsePersonality(entry);
    return {
        kind,
        fields: fieldsFor(kind),
        manual_fields: parseManualFields(entry),
        appearance: parseAppearance(entry) as Record<string, unknown> | null,
        appearance_text: entry.appearance_text,
        personality: personality.fields as Record<string, unknown> | null,
        personality_text: personality.text,
        evidence: parseEvidence(entry).map(item => ({ ...item, session_id: item.session_id ?? null })),
        confidence: entry.confidence,
        is_manual: entry.is_manual === 1,
        provider: entry.provider,
        model: entry.model,
        generated_at: entry.generated_at,
        stale_since_session_id: entry.stale_since_session_id,
    };
}
