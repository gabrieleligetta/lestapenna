import { Link } from 'react-router-dom';
import { useSessionDetail } from '../../api/hooks';
import { useLocale, useT } from '../../i18n';
import { ErrorState, Loading } from '../../components/StateViews';
import { Badge } from '../../components/Badge';
import type { SessionRef } from '../../api/types';
import type { ReactNode } from 'react';
import { StatusBadge } from '../../components/StatusBadge';

/** One cross-reference list: what the session produced, linked where a short_id exists. */
function RefList<T extends SessionRef>({
    title,
    rows,
    label,
    href,
}: {
    title: string;
    rows: T[];
    label: (row: T) => ReactNode;
    href: (row: T) => string | null;
}) {
    if (rows.length === 0) return null;
    return (
        <section>
            <h2>{title}</h2>
            <ul className="plain-list">
                {rows.map((row, i) => {
                    const url = href(row);
                    return <li key={`${row.short_id ?? 'reference'}-${i}`}>{url ? <Link to={url}>{label(row)}</Link> : label(row)}</li>;
                })}
            </ul>
        </section>
    );
}

export function SessionDetailView({ campaignId, base, sessionId }: { campaignId: string; base: string; sessionId: string }) {
    const t = useT();
    const { locale } = useLocale();
    const { data: session, isLoading, isError, error } = useSessionDetail(campaignId, sessionId);

    if (isLoading) return <Loading />;
    if (isError || !session) return <ErrorState error={error} />;

    return (
        <div className="detail-split">
            <div>
                <h1>{session.title ?? session.session_id}</h1>
                <p className="subtitle">
                    {session.start_time ? new Date(session.start_time).toLocaleString(locale) : '—'}
                    {session.session_number ? ` · #${session.session_number}` : ''}
                </p>

                {/* Tone, act count and token cost: recorded at generation time and
                    never surfaced anywhere in the bot. */}
                {session.metadata && (
                    <div className="badge-row">
                        {session.metadata.tone && <Badge tone="neutral">{session.metadata.tone}</Badge>}
                        {session.metadata.acts > 1 && <Badge tone="neutral">{t.sessions.acts(session.metadata.acts)}</Badge>}
                        {session.metadata.tokens > 0 && (
                            <Badge tone="neutral">{t.sessions.tokens(session.metadata.tokens.toLocaleString(locale))}</Badge>
                        )}
                    </div>
                )}

                {session.brief && (
                    <section>
                        <h2>{t.overview.lastSession}</h2>
                        <p>{session.brief}</p>
                    </section>
                )}

                {session.narrative && (
                    <section>
                        <h2>{t.entities.sessions}</h2>
                        <p style={{ whiteSpace: 'pre-wrap' }}>{session.narrative}</p>
                    </section>
                )}
            </div>

            <div>
                <RefList
                    title={t.entities.npcs}
                    rows={session.npcsEncountered}
                    label={(npc) => npc.name}
                    href={(npc) => (npc.short_id ? `${base}/npcs/${npc.short_id}` : null)}
                />
                <RefList
                    title={t.entities.quests}
                    rows={session.quests}
                    label={(quest) => (
                        <span className="inline-reference">
                            <span>{quest.title}</span>
                            <StatusBadge status={quest.status} />
                        </span>
                    )}
                    href={(quest) => (quest.short_id ? `${base}/quests/${quest.short_id}` : null)}
                />
                <RefList
                    title={t.entities.inventory}
                    rows={session.inventory}
                    label={(item) => `${item.item_name} ×${item.quantity}`}
                    href={(item) => (item.short_id ? `${base}/inventory/${item.short_id}` : null)}
                />
                <RefList
                    title={t.entities.bestiary}
                    rows={session.bestiary}
                    label={(monster) => monster.name}
                    href={(monster) => (monster.short_id ? `${base}/bestiary/${monster.short_id}` : null)}
                />

                {session.travels.length > 0 && (
                    <section>
                        <h2>{t.entities.locations}</h2>
                        <ul className="plain-list">
                            {session.travels.map((travel, i) => (
                                <li key={i}>
                                    {travel.macro_location} — {travel.micro_location}
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                {session.notes.length > 0 && (
                    <section>
                        <h2>{t.fields.description}</h2>
                        <ul className="event-list">
                            {session.notes.map((note) => (
                                <li key={note.id}>
                                    <div className="event-description">{note.content}</div>
                                    <div className="event-meta">{new Date(note.timestamp).toLocaleString(locale)}</div>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}
            </div>
        </div>
    );
}
