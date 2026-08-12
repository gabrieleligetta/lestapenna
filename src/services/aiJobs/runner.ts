import { aiJobRepository, type AiJobErrorKind, type AiJobKind, type AiJobRow } from '../../db/repositories/AiJobRepository';
import { runWithAiScope } from '../../bard/ai/ambientScope';
import { scopeForCampaign } from '../../bard/ai/scope';
import { classifyProviderError, redactKeyLike } from '../../bard/ai/providerErrors';
import { AiNotConfiguredError } from '../../bard/ai/types';
import { phaseConfigFor } from '../../bard/config';
import type { AIProvider } from '../../config';
import { logger } from '../../utils/logger';
import { aiJobEvents } from './events';
import { AI_JOB_REVIEW_TTL_MS, AiJobFailure, type AiJobHandler } from './types';

const log = logger('AiJobRunner');

/** How many paid calls may be in flight at once, across the whole instance. */
const MAX_CONCURRENT = 2;

/**
 * How often the pile is checked even when nothing announced itself.
 *
 * The normal path is the `enqueued` event, which starts a job in milliseconds.
 * This is the net underneath: a row written by something that forgot to emit,
 * or one left queued by a restart, still gets picked up.
 */
const TICK_MS = 15_000;

/**
 * Runs the paid work, one process, no queue server.
 *
 * **Why SQLite is the queue.** BullMQ is right for the audio pipeline — jobs
 * that last hours and need stall recovery — and wrong here for three concrete
 * reasons: Redis would become a second answer to "what is pending", free to
 * disagree with the register we actually trust; `attempts`/`backoff` are the
 * ergonomic default in this repo and a copy-paste of them onto a paid call is a
 * second charge on somebody's card; and with `DISABLE_REDIS=true` the queue stub
 * has no `add()` at all, so local development and every test would throw. The
 * work runs in the process that accepted it and lasts under a minute. There is
 * nothing to distribute.
 *
 * **Why it starts with the API and not with the bot.** `startWorker()` lives
 * inside the Discord `ready` handler, so nothing there runs if the gateway never
 * connects — and the API-only preview has no Discord at all. This work is
 * web-originated and must not depend on a chat connection.
 */
export class AiJobRunner {
    private timer: NodeJS.Timeout | null = null;
    private unsubscribe: (() => void) | null = null;
    private readonly active = new Map<string, Promise<void>>();
    private draining = false;

    constructor(private readonly handlers: Record<AiJobKind, AiJobHandler>) {}

    /**
     * Takes over from whatever the last process left behind, then starts.
     *
     * The sweep comes first and on purpose: a row still marked `running` belongs
     * to a process that no longer exists, and leaving it there would block its
     * target forever behind the one-active-job rule.
     */
    start(): void {
        const interrupted = aiJobRepository.failInterrupted();
        if (interrupted > 0) {
            log.warn(`${interrupted} AI job(s) were interrupted by a restart and have been closed`);
        }

        this.unsubscribe = aiJobEvents.onEnqueued(() => void this.drain());
        this.timer = setInterval(() => void this.drain(), TICK_MS);
        // Timers must not be what keeps the process alive at shutdown.
        this.timer.unref?.();
        void this.drain();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.unsubscribe?.();
        this.unsubscribe = null;
    }

    /** True while this instance is executing something. */
    get busy(): boolean {
        return this.active.size > 0 || this.draining;
    }

    /**
     * Claims what it can and runs it.
     *
     * Re-entrant by design: the event and the tick can both land at once, and
     * the guard plus the atomic claim mean the worst case is a wasted query
     * rather than a job executed twice.
     */
    async drain(): Promise<void> {
        if (this.draining) return;
        this.draining = true;
        try {
            while (this.active.size < MAX_CONCURRENT) {
                const free = MAX_CONCURRENT - this.active.size;
                const candidates = aiJobRepository.listClaimable(free);
                if (candidates.length === 0) return;

                let claimedAny = false;
                for (const candidate of candidates) {
                    if (this.active.size >= MAX_CONCURRENT) break;
                    if (!aiJobRepository.claim(candidate.id)) continue;
                    claimedAny = true;
                    this.launch(candidate.id);
                }
                if (!claimedAny) return;
            }
        } finally {
            this.draining = false;
        }
    }

    /**
     * Runs to completion and stops.
     *
     * For callers that need the pile empty rather than moving: the tests, which
     * must assert on an outcome and cannot wait on a fifteen-second timer.
     */
    async waitForIdle(): Promise<void> {
        for (;;) {
            await this.drain();
            if (this.active.size === 0) return;
            await Promise.allSettled([...this.active.values()]);
        }
    }

    private launch(id: string): void {
        const started = aiJobRepository.getById(id);
        if (started) aiJobEvents.emitChanged(started);

        const work = this.execute(id)
            .catch(error => log.error(`AI job ${id} failed to be finalised`, error as Error))
            .finally(() => {
                this.active.delete(id);
                const finished = aiJobRepository.getById(id);
                if (finished) aiJobEvents.emitChanged(finished);
            });

        this.active.set(id, work);
    }

    private async execute(id: string): Promise<void> {
        const job = aiJobRepository.getById(id);
        if (!job) return;

        try {
            /*
             * The scope has to be re-entered here.
             *
             * It lives in an AsyncLocalStorage filled by the HTTP interceptor,
             * and that request is long gone. Without this, everything in the
             * pipeline that does not take the scope as a parameter would throw —
             * which is the correct failure, since `requireAiScope()` has no
             * fallback on purpose: there is no "us" that can pay on a table's
             * behalf. Same re-entry `runWithSessionScope` performs after the
             * BullMQ boundary, for the same reason.
             */
            const outcome = await runWithAiScope(
                scopeForCampaign(job.campaign_id),
                () => this.handlers[job.kind].run(job),
            );

            if (outcome.status === 'awaiting_review') {
                aiJobRepository.markAwaitingReview(job.id, {
                    originalKey: outcome.originalKey,
                    displayKey: outcome.displayKey,
                    summary: outcome.summary,
                    expiresAt: Date.now() + (outcome.ttlMs ?? AI_JOB_REVIEW_TTL_MS),
                });
            } else {
                aiJobRepository.markSucceeded(job.id, outcome.summary);
            }
        } catch (error) {
            const { kind, message } = classifyJobFailure(job, error);
            log.error(`AI job ${job.id} (${job.kind}) failed: ${kind}`, error as Error);
            aiJobRepository.markFailed(job.id, kind, message);
        }
    }
}

/**
 * Turns whatever was thrown into something a person can act on.
 *
 * The same three-way split the HTTP layer makes: something you must change,
 * something you only have to wait out, and something that is ours. Keeping the
 * provider's own words for the first case is what lets someone fix a retired
 * model name in their own settings instead of reading server logs.
 */
export function classifyJobFailure(
    job: AiJobRow,
    error: unknown,
): { kind: AiJobErrorKind; message: string } {
    if (error instanceof AiJobFailure) {
        return { kind: error.errorKind, message: redactKeyLike(error.message) };
    }
    if (error instanceof AiNotConfiguredError) {
        return {
            kind: 'not_configured',
            message: `This server has no ${error.provider} key configured for the ${error.phase} phase`,
        };
    }

    const provider = safeProviderFor(job);
    const classified = classifyProviderError(provider, error);
    if (classified.kind !== 'UNKNOWN') {
        return { kind: 'provider', message: redactKeyLike(classified.raw || String(error)) };
    }
    return { kind: 'internal', message: redactKeyLike((error as Error)?.message ?? String(error)) };
}

/**
 * Which provider to read the error with.
 *
 * Best effort on purpose: the classification works on codes and messages rather
 * than on the provider, so a wrong guess costs nothing — while letting the
 * lookup throw here would replace a useful message with a useless one.
 */
function safeProviderFor(job: AiJobRow): AIProvider {
    if (job.provider) return job.provider as AIProvider;
    try {
        return phaseConfigFor(
            job.kind === 'image' ? 'image' : 'analyst',
            scopeForCampaign(job.campaign_id),
        ).provider;
    } catch {
        return 'openai';
    }
}
