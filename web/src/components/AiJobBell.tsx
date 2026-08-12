import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMyAiJobs } from '../api/hooks';
import type { AiJob } from '../api/types';
import { useLocale, useT } from '../i18n';
import { formatAiMoney } from './aiCostFormatting';
import { targetPath } from './AiJobDock';
import { Empty } from './StateViews';
import { Icon } from './icons';
import { Modal } from './Modal';

/**
 * What the AI did for you while you were not looking.
 *
 * The card in the corner covers "I am here now"; this covers "I came back
 * later" — a picture generated before dinner is still waiting, and the badge is
 * how somebody finds out without remembering which sheet they were on. Every row
 * leads to the same place the card does: the sheet where the decision is taken.
 *
 * Opening it marks everything finished as read, which is what the badge counts.
 * A job still running is deliberately left unread: its outcome has not happened
 * yet, and silencing it now would suppress the notification it is about to
 * produce.
 */
export function AiJobBell() {
    const t = useT();
    const { locale } = useLocale();
    const { data, markSeen } = useMyAiJobs();
    const [open, setOpen] = useState(false);

    const unseen = data?.unseen_count ?? 0;
    const items = data?.items ?? [];

    function show() {
        setOpen(true);
        if (unseen > 0) void markSeen();
    }

    return (
        <>
            <button
                type="button"
                className="icon-button ai-job-bell"
                onClick={show}
                aria-label={unseen > 0 ? t.aiJobs.bellWithCount(unseen) : t.aiJobs.bellLabel}
                title={t.aiJobs.bellLabel}
            >
                <Icon name="bell" />
                {unseen > 0 && <span className="ai-job-bell__count">{unseen}</span>}
            </button>

            <Modal open={open} onClose={() => setOpen(false)} title={t.aiJobs.bellLabel}>
                {items.length === 0 ? (
                    <Empty message={t.aiJobs.empty} />
                ) : (
                    <ul className="ai-job-list">
                        {items.map((job) => (
                            <li key={job.id} className="ai-job-list__item">
                                <Link to={targetPath(job)} onClick={() => setOpen(false)}>
                                    <strong>{t.aiJobs.kind[job.kind]}</strong>
                                    {job.target_label && <span> · {job.target_label}</span>}
                                </Link>
                                <small>
                                    {statusLabel(job, t)}
                                    {' · '}
                                    {new Date(job.created_at).toLocaleString(locale)}
                                    {job.charged && (
                                        <>
                                            {' · '}
                                            {job.cost_usd === null && job.cost_eur === null
                                                ? t.media.costUnknown
                                                : formatAiMoney(
                                                    job.cost_eur ?? job.cost_usd!,
                                                    job.cost_eur === null ? 'USD' : 'EUR',
                                                    locale,
                                                )}
                                        </>
                                    )}
                                </small>
                            </li>
                        ))}
                    </ul>
                )}
            </Modal>
        </>
    );
}

function statusLabel(job: AiJob, t: ReturnType<typeof useT>): string {
    switch (job.status) {
        case 'queued':
        case 'running': return t.aiJobs.working;
        case 'awaiting_review': return t.aiJobs.readyToReview;
        case 'succeeded': return t.aiJobs.done;
        case 'discarded': return t.aiJobs.discarded;
        case 'expired': return t.aiJobs.expired;
        default: return job.error_kind === 'interrupted' ? t.aiJobs.interrupted : t.aiJobs.failed;
    }
}
