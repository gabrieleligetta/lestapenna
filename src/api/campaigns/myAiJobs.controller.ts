import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiNoContentResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { SessionGuard } from '../auth/session.guard';
import type { AuthenticatedRequest } from '../auth/types';
import { assertMutationOrigin } from '../common/mutationOrigin';
import { AiJobsService, toAiJobDto } from './aiJobs.service';
import { aiJobEvents } from '../../services/aiJobs/events';
import { MyAiJobsDto } from './dto/aiJob.dto';

/** How often the stream says something, so idle proxies do not close it. */
const HEARTBEAT_MS = 25_000;

/**
 * A person's own AI work, wherever they asked for it.
 *
 * **Why this needs no campaign guard.** Every query here is `requested_by = me`.
 * You cannot reach somebody else's row through this controller at all, so there
 * is nothing membership could additionally protect — and asking for it would
 * mean resolving every campaign a person belongs to on each poll. Approving on
 * another person's behalf is a different capability and lives where it belongs:
 * on the campaign-scoped routes, behind `CampaignAccessGuard`.
 */
@ApiTags('ai-jobs')
@Controller('api/v1/me/ai-jobs')
@UseGuards(SessionGuard)
export class MyAiJobsController {
    constructor(private readonly jobs: AiJobsService) {}

    @Get()
    @ApiQuery({ name: 'limit', required: false, type: Number })
    @ApiOkResponse({ type: MyAiJobsDto })
    mine(@Req() request: AuthenticatedRequest, @Query('limit') limit?: string): MyAiJobsDto {
        const parsed = Number.parseInt(limit ?? '', 10);
        return this.jobs.mine(request, Number.isInteger(parsed) ? parsed : 20);
    }

    /**
     * Marks outcomes as read.
     *
     * Only the finished ones, in the repository: silencing a job that is still
     * running would suppress the very notification it is about to produce.
     */
    @Post('seen')
    @HttpCode(204)
    @ApiNoContentResponse()
    markSeen(@Req() request: AuthenticatedRequest, @Body() body?: { ids?: string[] }): void {
        assertMutationOrigin(request);
        const ids = Array.isArray(body?.ids)
            ? body!.ids.filter((id): id is string => typeof id === 'string')
            : undefined;
        this.jobs.markSeen(request, ids);
    }

    /**
     * The live channel: one event per state change, as it happens.
     *
     * **Server-sent events and not a WebSocket.** Everything here travels one
     * way, from the server to a page that only ever listens; `EventSource`
     * reconnects on its own, the session cookie authenticates it like any other
     * request, and it crosses the reverse proxy as an ordinary HTTP response. A
     * WebSocket would add a dependency and a second protocol to carry messages
     * in a direction nobody uses.
     *
     * It is a courtesy, not the record: a browser that misses an event — or
     * whose proxy closes the stream — gets the truth from the ordinary GET on
     * the next focus or the slow poll. That is what makes a lost connection
     * harmless, which is the whole point of the register underneath.
     */
    @Get('stream')
    @ApiExcludeEndpoint()
    stream(@Req() request: AuthenticatedRequest, @Res() reply: FastifyReply): void {
        const userId = request.webSession.discordUserId;

        // Fastify must not try to send a response of its own on top of this one.
        reply.hijack();
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            // Some proxies buffer a streamed response into uselessness.
            'X-Accel-Buffering': 'no',
        });
        // An initial comment flushes the headers, so the browser fires `open`
        // now rather than at the first job.
        reply.raw.write(': connected\n\n');

        const send = (event: string, data: unknown): void => {
            if (reply.raw.writableEnded) return;
            reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        const unsubscribe = aiJobEvents.onChanged(job => {
            if (job.requested_by !== userId) return;
            send('job', toAiJobDto(job));
        });
        const heartbeat = setInterval(() => {
            if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n');
        }, HEARTBEAT_MS);
        heartbeat.unref?.();

        const close = (): void => {
            clearInterval(heartbeat);
            unsubscribe();
            if (!reply.raw.writableEnded) reply.raw.end();
        };
        request.raw.on('close', close);
        request.raw.on('error', close);
    }
}
