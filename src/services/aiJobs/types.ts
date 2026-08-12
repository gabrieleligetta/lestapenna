import type { AiJobErrorKind, AiJobRow } from '../../db/repositories/AiJobRepository';

/**
 * How long a result waits for somebody to accept it.
 *
 * Seven days, where the in-memory draft it replaces gave ten minutes. That
 * number was sized for a megabyte held in RAM; this one is sized for what the
 * thing actually is — a picture the table has already paid for, sitting in a
 * bucket. Throwing it away because somebody went to dinner was the bug.
 */
export const AI_JOB_REVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** What a handler produced. Failure is thrown, not returned. */
export type AiJobOutcome =
    /** Done and written; nothing to decide. */
    | { status: 'succeeded'; summary?: unknown }
    /** There is an artifact, and a person has to accept or refuse it. */
    | {
        status: 'awaiting_review';
        originalKey: string;
        displayKey: string;
        summary?: unknown;
        ttlMs?: number;
    };

/**
 * A failure the user can be told something useful about.
 *
 * Handlers throw this when they already know what went wrong — a refused
 * prompt, a missing model — so the runner does not have to re-derive it from an
 * exception it has never seen.
 */
export class AiJobFailure extends Error {
    constructor(readonly errorKind: AiJobErrorKind, message: string) {
        super(message);
        this.name = 'AiJobFailure';
    }
}

/**
 * One kind of paid work.
 *
 * `run` is called **outside** the HTTP request that asked for it, inside the
 * campaign's AI scope. It gets the row and nothing else: whatever it needs was
 * written to `params_json` when the request was still around.
 */
export interface AiJobHandler {
    run(job: AiJobRow): Promise<AiJobOutcome>;
}
