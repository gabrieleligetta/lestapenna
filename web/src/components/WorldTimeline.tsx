import { Link } from 'react-router-dom';
import type { EntityRow } from '../api/types';
import { useLocale, useT } from '../i18n';
import { Icon } from './icons';
import { eventPresentation } from './eventPresentation';

function eventDate(value: unknown, locale: string): string | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const milliseconds = value < 100_000_000_000 ? value * 1_000 : value;
    return new Date(milliseconds).toLocaleDateString(locale);
}

export function WorldTimeline({ items, base }: { items: EntityRow[]; base: string }) {
    const t = useT();
    const { locale } = useLocale();

    return (
        <ol className="world-timeline">
            {items.map((event, index) => {
                const id = event.short_id == null ? '' : String(event.short_id);
                const type = event.event_type == null ? null : String(event.event_type);
                const presentation = eventPresentation(t, type);
                const year = event.year == null ? t.timeline.unknownYear : String(event.year);
                const date = eventDate(event.timestamp, locale);
                const description = String(event.description ?? '—');
                const sessionId = event.session_id == null ? null : String(event.session_id);

                return (
                    <li key={`${id || 'event'}-${index}`} className="world-timeline__event">
                        <div className="world-timeline__rail" aria-hidden="true">
                            <span className="world-timeline__marker">
                                <Icon name={presentation.icon} />
                            </span>
                        </div>
                        <article className="world-timeline__card">
                            <header className="world-timeline__head">
                                <span className="world-timeline__year">{year}</span>
                                <span className="event-type-badge">
                                    <Icon name={presentation.icon} />
                                    {presentation.label}
                                </span>
                            </header>
                            <p className="world-timeline__description">
                                {id ? <Link to={`${base}/timeline/${id}`}>{description}</Link> : description}
                            </p>
                            {(date || sessionId) && (
                                <footer className="world-timeline__meta">
                                    {date && (
                                        <span>
                                            <Icon name="calendar" />
                                            {date}
                                        </span>
                                    )}
                                    {sessionId && (
                                        <span>
                                            <Icon name="sessions" />
                                            {t.fields.session} {sessionId}
                                        </span>
                                    )}
                                </footer>
                            )}
                        </article>
                    </li>
                );
            })}
        </ol>
    );
}
