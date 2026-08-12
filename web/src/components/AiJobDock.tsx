import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMyAiJobs } from '../api/hooks';
import type { AiJob } from '../api/types';
import { useT } from '../i18n';
import { Icon } from './icons';

/** How long a finished job keeps its card before the bell takes over. */
const KEEP_FINISHED_MS = 10 * 60 * 1000;

/**
 * The card in the corner: what the AI is doing for you, right now.
 *
 * It lives in `AppShell`, above the router — which is the whole design. The
 * panel that starts a portrait sits inside a dialog on an entity's sheet, and
 * people close that dialog, open another sheet, or wander off to read the
 * journal while they wait. Anything that reported progress from inside the panel
 * would disappear with it; this does not.
 *
 * Clicking a finished card goes to the sheet that has something to accept, which
 * is the only place the decision can be taken. That is deliberately the same
 * destination the bell offers: two ways in, one place to decide.
 *
 * It is fed by the live stream in `useMyAiJobs`, so a picture turns green the
 * moment it is ready rather than at the next poll — but the query underneath is
 * what it trusts, because a stream can be closed by any proxy in between.
 */
export function AiJobDock() {
    const t = useT();
    const { data } = useMyAiJobs();
    const [dismissed, setDismissed] = useState<string[]>([]);

    const jobs = (data?.items ?? []).filter((job) => {
        if (dismissed.includes(job.id)) return false;
        if (job.status === 'queued' || job.status === 'running') return true;
        // A decision still to take stays until it is taken; anything else fades
        // out of the corner and lives on in the bell.
        if (job.status === 'awaiting_review') return true;
        if (job.seen_at !== null) return false;
        return job.finished_at !== null && Date.now() - job.finished_at < KEEP_FINISHED_MS;
    });

    if (jobs.length === 0) return null;

    return (
        <div className="ai-job-dock" aria-live="polite" aria-label={t.aiJobs.dockLabel}>
            {jobs.map((job) => (
                <AiJobCard key={job.id} job={job} onDismiss={() => setDismissed((ids) => [...ids, job.id])} />
            ))}
        </div>
    );
}

function AiJobCard({ job, onDismiss }: { job: AiJob; onDismiss: () => void }) {
    const t = useT();
    const working = job.status === 'queued' || job.status === 'running';
    const decide = job.status === 'awaiting_review';
    const failed = job.status === 'failed';

    const tone = working ? 'working' : decide ? 'ready' : failed ? 'failed' : 'done';
    const body = (
        <>
            <span className="ai-job-card__icon" aria-hidden="true">
                <Icon name={working ? 'loading' : decide ? 'sparkles' : failed ? 'error' : 'check'} />
            </span>
            <span className="ai-job-card__text">
                <strong>{t.aiJobs.kind[job.kind]}</strong>
                {job.target_label && <span className="ai-job-card__subject">{job.target_label}</span>}
                <small>
                    {working && t.aiJobs.working}
                    {decide && t.aiJobs.readyToReview}
                    {failed && (job.error_kind === 'interrupted' ? t.aiJobs.interrupted : t.aiJobs.failed)}
                    {job.status === 'succeeded' && t.aiJobs.done}
                </small>
            </span>
        </>
    );

    return (
        <div className={`ai-job-card ai-job-card--${tone}`}>
            {decide ? (
                // Straight to the sheet, where the picture can be accepted. A
                // card that announces a decision and does not lead to it would
                // be a notification about nothing.
                <Link className="ai-job-card__body" to={targetPath(job)}>{body}</Link>
            ) : (
                <span className="ai-job-card__body">{body}</span>
            )}
            {!working && (
                <button
                    type="button"
                    className="icon-button ai-job-card__close"
                    onClick={onDismiss}
                    aria-label={t.common.close}
                >
                    <Icon name="close" />
                </button>
            )}
        </div>
    );
}

/** Where a job's outcome can be acted on. */
export function targetPath(job: AiJob): string {
    const base = `/guilds/${job.guild_id}/campaigns/${job.campaign_id}`;
    switch (job.target_type) {
        case 'npc': return `${base}/npcs/${job.target_key}`;
        case 'location': return `${base}/locations/${job.target_key}`;
        case 'artifact': return `${base}/artifacts/${job.target_key}`;
        // A character sheet is reached through the party page, which is where
        // its portrait and biography are edited.
        case 'character': return `${base}/party`;
        default: return `${base}/quests`;
    }
}
