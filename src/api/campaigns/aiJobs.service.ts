import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/types';
import {
    aiJobRepository,
    parseAiJobParams,
    parseAiJobResult,
    type AiJobRow,
    type AiJobStatus,
} from '../../db/repositories/AiJobRepository';
import { aiUsageRepository } from '../../db/repositories/AiUsageRepository';
import { campaignRepository } from '../../db/repositories/CampaignRepository';
import { canManageMembership } from '../../services/campaignAccess';
import { aiJobEvents } from '../../services/aiJobs/events';
import type { AiJobDto, MyAiJobsDto } from './dto/aiJob.dto';

/**
 * Reading the register, and deciding who may act on a row.
 *
 * Two rules, and they are different on purpose:
 *
 *  - **seeing** somebody else's job is a campaign matter — a master runs the
 *    table and its spending, so they see everything; anyone else sees their own
 *    work. A row that is not yours answers **404 rather than 403**, because a
 *    403 would confirm it exists;
 *  - **approving** is the requester or a master. Not simply "whoever may write
 *    to the entity": that is every player at the table, and it would let anyone
 *    accept a picture somebody else paid for.
 */
@Injectable()
export class AiJobsService {
    listForCampaign(
        request: AuthenticatedRequest,
        options: { statuses?: AiJobStatus[]; limit?: number } = {},
    ): AiJobDto[] {
        const campaignId = request.campaignId!;
        const rows = aiJobRepository.listForCampaign(campaignId, {
            requestedBy: this.isMaster(request) ? undefined : request.webSession.discordUserId,
            statuses: options.statuses,
            limit: options.limit,
        });
        return rows.map(toAiJobDto);
    }

    getOne(request: AuthenticatedRequest, jobId: string): AiJobDto {
        return toAiJobDto(this.requireVisible(request, jobId));
    }

    mine(request: AuthenticatedRequest, limit = 20): MyAiJobsDto {
        const userId = request.webSession.discordUserId;
        return {
            items: aiJobRepository.listForUser(userId, limit).map(toAiJobDto),
            unseen_count: aiJobRepository.countUnseen(userId),
            active_count: aiJobRepository.countActive(userId),
        };
    }

    markSeen(request: AuthenticatedRequest, ids?: string[]): void {
        aiJobRepository.markSeen(request.webSession.discordUserId, Date.now(), ids);
    }

    /**
     * The row, if this person is allowed to know about it.
     *
     * Used by every read path, so the 404-not-403 rule lives in one place.
     */
    requireVisible(request: AuthenticatedRequest, jobId: string): AiJobRow {
        const job = aiJobRepository.getById(jobId);
        if (!job || job.campaign_id !== request.campaignId) {
            throw new NotFoundException('No such job in this campaign');
        }
        if (job.requested_by !== request.webSession.discordUserId && !this.isMaster(request)) {
            throw new NotFoundException('No such job in this campaign');
        }
        return job;
    }

    /** The row, if this person may accept or refuse what it produced. */
    requireDecidable(request: AuthenticatedRequest, jobId: string): AiJobRow {
        const job = this.requireVisible(request, jobId);
        if (job.requested_by !== request.webSession.discordUserId && !this.isMaster(request)) {
            throw new ForbiddenException('Only who asked for this, or a master of the table, can decide on it');
        }
        return job;
    }

    private isMaster(request: AuthenticatedRequest): boolean {
        return canManageMembership(request.campaignId!, request.webSession.discordUserId, {
            guildCanManage: request.guildAccess?.canManage ?? false,
        });
    }
}

/**
 * The row as the browser reads it, with the money resolved from the ledger.
 *
 * The cost is not stored here and never will be: `ai_usage_log` is the single
 * accounting record, and a copy on this row would be a second figure free to
 * disagree with it. What the row does carry is `usage_run_id`, which is both the
 * pointer to that record and the statement that the provider was paid.
 */
export function toAiJobDto(job: AiJobRow): AiJobDto {
    const ledger = job.usage_run_id
        ? aiUsageRepository.getRunCost(job.usage_run_id)
        : { costUsd: null, costEur: null, rows: 0 };
    /*
     * A partial ledger is not a cost.
     *
     * A generation can be two calls at two rates, and only one of them may have
     * a published price — the brief's model is well known, the picture's may
     * have been released last week. Summing what we happen to know would show a
     * tenth of a cent for a job that cost thirteen, which is worse than
     * admitting we do not know: it is a wrong number that looks like a right
     * one. `pricing_available` is the flag the runner set when the priced part
     * was complete, so it is what decides whether there is a figure at all.
     */
    const known = job.pricing_available === 1 && ledger.rows > 0;
    const cost = known ? ledger : { costUsd: null, costEur: null, rows: ledger.rows };
    const params = parseAiJobParams<{ userPrompt?: string | null }>(job);

    return {
        id: job.id,
        campaign_id: job.campaign_id,
        // Not a column: a job belongs to a campaign, and the campaign knows its
        // guild. Storing it twice would be a second copy free to go stale.
        guild_id: campaignRepository.getCampaignById(job.campaign_id)?.guild_id ?? '',
        kind: job.kind,
        target_type: job.target_type,
        target_key: job.target_key,
        target_label: job.target_label,
        requested_by: job.requested_by,
        status: job.status,
        error_kind: job.error_kind,
        error_message: job.error_message,
        provider: job.provider,
        model: job.model,
        cost_usd: cost.costUsd,
        cost_eur: cost.costEur,
        // Two conditions, because they fail separately: the job may have run on
        // a model with no published rate, or the ledger write itself may have
        // failed after the money was already gone.
        pricing_available: known,
        charged: job.usage_run_id !== null,
        seen_at: job.seen_at,
        created_at: job.created_at,
        finished_at: job.finished_at,
        expires_at: job.expires_at,
        result: parseAiJobResult<Record<string, unknown>>(job),
        prompt: params?.userPrompt ?? null,
    };
}

/** Publishes a row to whoever is watching. Called after every write. */
export function announceAiJob(jobId: string): void {
    const job = aiJobRepository.getById(jobId);
    if (job) aiJobEvents.emitChanged(job);
}
