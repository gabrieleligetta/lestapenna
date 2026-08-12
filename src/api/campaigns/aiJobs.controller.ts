import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../auth/session.guard';
import type { AuthenticatedRequest } from '../auth/types';
import { CampaignAccessGuard } from './campaignAccess.guard';
import { AiJobsService } from './aiJobs.service';
import { AI_JOB_STATUSES, AiJobDto } from './dto/aiJob.dto';
import type { AiJobStatus } from '../../db/repositories/AiJobRepository';

/**
 * The table's register of paid AI work.
 *
 * Who sees what is decided here rather than by a guard, because it **filters**
 * instead of refusing: a master runs the table and its spending, so they see
 * every row; anybody else sees the work they asked for themselves. A row that
 * belongs to neither answers 404, not 403 — a 403 would confirm it exists.
 */
@ApiTags('ai-jobs')
@Controller('api/v1/campaigns')
@UseGuards(SessionGuard, CampaignAccessGuard)
export class AiJobsController {
    constructor(private readonly jobs: AiJobsService) {}

    @Get(':campaignId/ai-jobs')
    @ApiQuery({ name: 'status', required: false, enum: AI_JOB_STATUSES, isArray: true })
    @ApiQuery({ name: 'limit', required: false, type: Number })
    @ApiOkResponse({ type: [AiJobDto] })
    list(
        @Req() request: AuthenticatedRequest,
        @Query('status') status?: string | string[],
        @Query('limit') limit?: string,
    ): AiJobDto[] {
        const requested = (Array.isArray(status) ? status : status ? [status] : [])
            .filter((value): value is AiJobStatus =>
                (AI_JOB_STATUSES as readonly string[]).includes(value));
        const parsed = Number.parseInt(limit ?? '', 10);

        return this.jobs.listForCampaign(request, {
            statuses: requested.length > 0 ? requested : undefined,
            limit: Number.isInteger(parsed) ? parsed : undefined,
        });
    }

    @Get(':campaignId/ai-jobs/:jobId')
    @ApiOkResponse({ type: AiJobDto })
    getOne(@Req() request: AuthenticatedRequest, @Param('jobId') jobId: string): AiJobDto {
        return this.jobs.getOne(request, jobId);
    }
}
