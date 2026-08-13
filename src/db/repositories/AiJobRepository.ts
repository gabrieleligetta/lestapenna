import { randomUUID } from 'crypto';
import { db } from '../client';

/**
 * The register of on-demand AI work.
 *
 * Everything here exists to keep one promise: **work the table has paid for is
 * never lost, and never paid for twice.** Both halves are enforced by the
 * database rather than by discipline —
 *
 *  - the partial unique index `idx_ai_job_active` makes a second live job on the
 *    same target impossible, which is what the per-process `Set`s could not do
 *    across a restart;
 *  - there is no method that re-runs anything. `failInterrupted()` closes jobs a
 *    crash left behind and closes them as *failed*, because a call that may
 *    already have been charged must never be repeated on its own.
 */

export type AiJobKind = 'image' | 'appearance' | 'quest-audit' | 'character-bio';

export type AiJobTargetType = 'npc' | 'location' | 'character' | 'artifact' | 'campaign';

export type AiJobStatus =
    /** Written, not yet picked up. Nothing has been spent. */
    | 'queued'
    /** The provider may be being called right now. */
    | 'running'
    /** It produced something a person has to accept or refuse. */
    | 'awaiting_review'
    | 'succeeded'
    | 'discarded'
    | 'failed'
    /** Nobody decided in time; the artifact is gone, the record stays. */
    | 'expired';

export type AiJobErrorKind =
    /** The provider drew nothing and said why: the request has to change. */
    | 'refused'
    /** A selected reference disappeared, expired or could not be read. */
    | 'reference'
    /** No model or no key for the phase — a settings problem, not a failure. */
    | 'not_configured'
    /** The provider was unreachable, rate-limited or out of credit. */
    | 'provider'
    /** The picture was made but could not be stored. */
    | 'storage'
    /** The process died mid-flight. It may have been charged. */
    | 'interrupted'
    | 'internal';

/** The states from which nothing more happens on its own. */
export const TERMINAL_AI_JOB_STATUSES: readonly AiJobStatus[] = [
    'succeeded', 'discarded', 'failed', 'expired',
];

export interface AiJobRow {
    id: string;
    campaign_id: number;
    kind: AiJobKind;
    target_type: AiJobTargetType;
    target_key: string;
    target_label: string | null;
    requested_by: string;
    status: AiJobStatus;
    params_json: string;
    result_json: string | null;
    result_original_key: string | null;
    result_display_key: string | null;
    error_kind: AiJobErrorKind | null;
    error_message: string | null;
    provider: string | null;
    model: string | null;
    pricing_available: number | null;
    usage_run_id: string | null;
    seen_at: number | null;
    created_at: number;
    started_at: number | null;
    finished_at: number | null;
    expires_at: number | null;
    updated_at: number;
}

export interface NewAiJob {
    campaignId: number;
    kind: AiJobKind;
    targetType: AiJobTargetType;
    targetKey: string;
    targetLabel?: string | null;
    requestedBy: string;
    params: unknown;
}

/**
 * Raised when the same target already has work in flight.
 *
 * Its own class because the answer to the user is a 409 with a sentence about
 * *that* action — "a picture for this entity is already being generated" — and
 * the API layer is where those sentences belong.
 */
export class ActiveJobExistsError extends Error {
    constructor(readonly existing: AiJobRow) {
        super(`A ${existing.kind} job is already running for ${existing.target_type} ${existing.target_key}`);
        this.name = 'ActiveJobExistsError';
    }
}

const ACTIVE = `status IN ('queued', 'running')`;

export const aiJobRepository = {
    /**
     * Records a job, refusing a second live one for the same target.
     *
     * The check and the insert share one transaction: better-sqlite3 is
     * synchronous, so within a process that alone is airtight, and the unique
     * index covers whatever the future brings.
     */
    enqueue(input: NewAiJob): AiJobRow {
        const now = Date.now();
        const id = randomUUID();

        return db.transaction(() => {
            const existing = aiJobRepository.activeFor(
                input.campaignId, input.kind, input.targetType, input.targetKey,
            );
            if (existing) throw new ActiveJobExistsError(existing);

            db.prepare(`
                INSERT INTO ai_job (
                    id, campaign_id, kind, target_type, target_key, target_label,
                    requested_by, status, params_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
            `).run(
                id,
                input.campaignId,
                input.kind,
                input.targetType,
                input.targetKey,
                input.targetLabel ?? null,
                input.requestedBy,
                JSON.stringify(input.params ?? {}),
                now,
                now,
            );

            return aiJobRepository.getById(id)!;
        })();
    },

    getById(id: string): AiJobRow | null {
        return (db.prepare('SELECT * FROM ai_job WHERE id = ?').get(id) as AiJobRow | undefined) ?? null;
    },

    activeFor(
        campaignId: number,
        kind: AiJobKind,
        targetType: AiJobTargetType,
        targetKey: string,
    ): AiJobRow | null {
        return (db.prepare(`
            SELECT * FROM ai_job
            WHERE campaign_id = ? AND kind = ? AND target_type = ? AND target_key = ? AND ${ACTIVE}
        `).get(campaignId, kind, targetType, targetKey) as AiJobRow | undefined) ?? null;
    },

    /**
     * Takes a queued job, or answers that somebody else already did.
     *
     * The `WHERE status = 'queued'` is the whole point: two ticks racing on the
     * same row cannot both win, so a job cannot be executed — and charged —
     * twice.
     */
    claim(id: string, now = Date.now()): boolean {
        return db.prepare(`
            UPDATE ai_job SET status = 'running', started_at = ?, updated_at = ?
            WHERE id = ? AND status = 'queued'
        `).run(now, now, id).changes === 1;
    },

    listClaimable(limit: number): AiJobRow[] {
        return db.prepare(
            `SELECT * FROM ai_job WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?`,
        ).all(limit) as AiJobRow[];
    },

    /**
     * Notes that the provider answered, before anything else is done with the
     * result. From here on `usage_run_id` says the money is gone.
     */
    recordSpend(id: string, spend: {
        usageRunId: string;
        provider: string;
        model: string;
        pricingAvailable: boolean;
    }): void {
        db.prepare(`
            UPDATE ai_job
            SET usage_run_id = ?, provider = ?, model = ?, pricing_available = ?, updated_at = ?
            WHERE id = ?
        `).run(
            spend.usageRunId,
            spend.provider,
            spend.model,
            spend.pricingAvailable ? 1 : 0,
            Date.now(),
            id,
        );
    },

    markAwaitingReview(id: string, result: {
        originalKey: string;
        displayKey: string;
        summary?: unknown;
        expiresAt: number;
    }): void {
        const now = Date.now();
        db.prepare(`
            UPDATE ai_job SET
                status = 'awaiting_review',
                result_original_key = ?, result_display_key = ?, result_json = ?,
                finished_at = ?, expires_at = ?, updated_at = ?
            WHERE id = ?
        `).run(
            result.originalKey,
            result.displayKey,
            result.summary === undefined ? null : JSON.stringify(result.summary),
            now,
            result.expiresAt,
            now,
            id,
        );
    },

    markSucceeded(id: string, summary?: unknown): void {
        const now = Date.now();
        db.prepare(`
            UPDATE ai_job SET
                status = 'succeeded', result_json = COALESCE(?, result_json),
                result_original_key = NULL, result_display_key = NULL,
                expires_at = NULL,
                finished_at = COALESCE(finished_at, ?), updated_at = ?
            WHERE id = ?
        `).run(summary === undefined ? null : JSON.stringify(summary), now, now, id);
    },

    markDiscarded(id: string): void {
        const now = Date.now();
        db.prepare(`
            UPDATE ai_job SET
                status = 'discarded', result_original_key = NULL, result_display_key = NULL,
                expires_at = NULL, updated_at = ?
            WHERE id = ?
        `).run(now, id);
    },

    markFailed(id: string, kind: AiJobErrorKind, message: string): void {
        const now = Date.now();
        db.prepare(`
            UPDATE ai_job SET
                status = 'failed', error_kind = ?, error_message = ?,
                finished_at = ?, updated_at = ?
            WHERE id = ?
        `).run(kind, message.slice(0, 2000), now, now, id);
    },

    /**
     * Closes what a crash left running.
     *
     * Deliberately not a re-queue. A `running` row is one we cannot tell apart
     * from a call the provider already served and billed; running it again would
     * charge the table twice for one picture, so the honest outcome is a failure
     * that says as much.
     */
    failInterrupted(now = Date.now()): number {
        return db.prepare(`
            UPDATE ai_job SET
                status = 'failed', error_kind = 'interrupted',
                error_message = 'The server restarted while this was running. It may already have been charged.',
                finished_at = ?, updated_at = ?
            WHERE status = 'running'
        `).run(now, now).changes;
    },

    /** When the last job of a kind finished on this campaign — the cooldown clock. */
    lastFinishedAt(campaignId: number, kind: AiJobKind): number | null {
        const row = db.prepare(`
            SELECT MAX(finished_at) AS last FROM ai_job WHERE campaign_id = ? AND kind = ?
        `).get(campaignId, kind) as { last: number | null };
        return row?.last ?? null;
    },

    listForCampaign(campaignId: number, options: {
        requestedBy?: string;
        statuses?: AiJobStatus[];
        limit?: number;
    } = {}): AiJobRow[] {
        const filters: string[] = ['campaign_id = ?'];
        const params: unknown[] = [campaignId];

        if (options.requestedBy) {
            filters.push('requested_by = ?');
            params.push(options.requestedBy);
        }
        if (options.statuses?.length) {
            filters.push(`status IN (${options.statuses.map(() => '?').join(', ')})`);
            params.push(...options.statuses);
        }
        params.push(Math.min(Math.max(options.limit ?? 50, 1), 200));

        return db.prepare(
            `SELECT * FROM ai_job WHERE ${filters.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
        ).all(...params) as AiJobRow[];
    },

    /** Everything a person started, wherever they started it. */
    listForUser(userId: string, limit = 20): AiJobRow[] {
        return db.prepare(`
            SELECT * FROM ai_job WHERE requested_by = ? ORDER BY created_at DESC LIMIT ?
        `).all(userId, Math.min(Math.max(limit, 1), 100)) as AiJobRow[];
    },

    countUnseen(userId: string): number {
        const row = db.prepare(`
            SELECT COUNT(*) AS n FROM ai_job
            WHERE requested_by = ? AND seen_at IS NULL AND status NOT IN ('queued', 'running')
        `).get(userId) as { n: number };
        return row.n;
    },

    countActive(userId: string): number {
        const row = db.prepare(
            `SELECT COUNT(*) AS n FROM ai_job WHERE requested_by = ? AND ${ACTIVE}`,
        ).get(userId) as { n: number };
        return row.n;
    },

    /**
     * Marks outcomes as read.
     *
     * Only the finished ones: a job still running has no outcome to have seen,
     * and marking it now would silence the very notification it is going to
     * produce.
     */
    markSeen(userId: string, now = Date.now(), ids?: string[]): number {
        if (ids && ids.length === 0) return 0;
        const scope = ids ? ` AND id IN (${ids.map(() => '?').join(', ')})` : '';
        return db.prepare(`
            UPDATE ai_job SET seen_at = ?
            WHERE requested_by = ? AND seen_at IS NULL AND status NOT IN ('queued', 'running')${scope}
        `).run(now, userId, ...(ids ?? [])).changes;
    },

    listExpired(now = Date.now(), limit = 200): AiJobRow[] {
        return db.prepare(`
            SELECT * FROM ai_job
            WHERE status = 'awaiting_review' AND expires_at IS NOT NULL AND expires_at <= ?
            ORDER BY expires_at ASC LIMIT ?
        `).all(now, limit) as AiJobRow[];
    },

    markExpired(id: string): void {
        db.prepare(`
            UPDATE ai_job SET
                status = 'expired', result_original_key = NULL, result_display_key = NULL,
                updated_at = ?
            WHERE id = ?
        `).run(Date.now(), id);
    },

    /**
     * Drops old finished rows.
     *
     * The register is a log, not an archive, and `params_json` holds what people
     * typed. Only terminal rows go, so nothing in flight can be swept away.
     */
    deleteFinishedBefore(cutoff: number): number {
        return db.prepare(`
            DELETE FROM ai_job
            WHERE status NOT IN ('queued', 'running', 'awaiting_review') AND finished_at < ?
        `).run(cutoff).changes;
    },
};

export function parseAiJobParams<T>(job: AiJobRow): T | null {
    try {
        return JSON.parse(job.params_json) as T;
    } catch {
        return null;
    }
}

export function parseAiJobResult<T>(job: AiJobRow): T | null {
    if (!job.result_json) return null;
    try {
        return JSON.parse(job.result_json) as T;
    } catch {
        return null;
    }
}
