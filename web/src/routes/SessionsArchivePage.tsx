import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useCampaignSessions } from '../api/hooks';
import { Empty, ErrorState, Loading } from '../components/StateViews';
import { useLocale, useT } from '../i18n';
import './sessions.css';

const PAGE_SIZE = 100;

function dateValue(timestamp: number, locale: string): string {
    if (!timestamp) return '—';
    const milliseconds = timestamp < 100_000_000_000 ? timestamp * 1_000 : timestamp;
    return new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(milliseconds));
}

export function SessionsArchivePage() {
    const { guildId = '', campaignId = '' } = useParams();
    const [offset, setOffset] = useState(0);
    const { data, isLoading, isError, error } = useCampaignSessions(campaignId, PAGE_SIZE, offset);
    const { locale } = useLocale();
    const t = useT();
    const base = `/guilds/${guildId}/campaigns/${campaignId}/sessions`;

    return (
        <div className="sessions-archive">
            <header className="sessions-archive__header">
                <p className="sessions-eyebrow">{t.sessions.eyebrow}</p>
                <h1>{t.sessions.archiveTitle}</h1>
                <p>{t.sessions.archiveSubtitle}</p>
            </header>

            {isLoading && <Loading />}
            {isError && <ErrorState error={error} />}
            {!isLoading && !isError && (data?.items.length ?? 0) === 0 && <Empty message={t.sessions.empty} />}

            {data && data.items.length > 0 && (
                <>
                    <ol className="session-index">
                        {data.items.map((session) => (
                            <li key={session.session_id} className="session-index__item">
                                <Link to={`${base}/${session.session_id}`} className="session-index__link">
                                    <span className="session-index__marker" aria-hidden="true" />
                                    <span className="session-index__date">{dateValue(session.start_time, locale)}</span>
                                    <strong>{session.title ?? t.sessions.untitled}</strong>
                                    <span className="session-index__number">
                                        {session.session_number == null
                                            ? t.sessions.openSession
                                            : t.sessions.sessionNumber(session.session_number)}
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ol>

                    {data.total > PAGE_SIZE && (
                        <nav className="sessions-pagination" aria-label={t.sessions.archivePagination}>
                            <button
                                type="button"
                                disabled={offset === 0}
                                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                            >
                                {t.common.prev}
                            </button>
                            <span>{t.common.range(offset + 1, offset + data.items.length, data.total)}</span>
                            <button
                                type="button"
                                disabled={offset + data.items.length >= data.total}
                                onClick={() => setOffset(offset + PAGE_SIZE)}
                            >
                                {t.common.next}
                            </button>
                        </nav>
                    )}
                </>
            )}
        </div>
    );
}
