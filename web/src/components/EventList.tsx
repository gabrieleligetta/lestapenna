import type { HistoryEvent } from '../api/types';
import { useLocale, useT } from '../i18n';
import { AlignmentDelta } from './AlignmentDelta';
import { Icon } from './icons';
import { eventPresentation } from './eventPresentation';

export interface EventActions {
    onEdit: (event: HistoryEvent) => void;
    onDelete: (event: HistoryEvent) => void;
}

/**
 * The per-entity history feed, shared by every detail view.
 *
 * `actions` arrives only for managers on an entity whose history is editable;
 * without it the list stays exactly the read-only feed it has always been.
 */
export function EventList({ events, actions }: { events: HistoryEvent[]; actions?: EventActions }) {
    const t = useT();
    const { locale } = useLocale();
    return (
        <ul className="event-list">
            {events.map((event) => {
                const presentation = eventPresentation(t, event.event_type);
                return (
                    <li key={event.id}>
                        <span className="event-list__icon" aria-hidden="true">
                            <Icon name={presentation.icon} />
                        </span>
                        <div className="event-list__body">
                            <div className="event-description">
                                {event.description}
                                {event.is_manual ? (
                                    <span className="event-manual" aria-hidden="true">
                                        <Icon name="edit" />
                                    </span>
                                ) : null}
                            </div>
                            <div className="event-meta">
                                <span>{event.timestamp ? new Date(event.timestamp).toLocaleString(locale) : '—'}</span>
                                <span>{presentation.label}</span>
                                {event.session_id && <span>{t.fields.session} {event.session_id}</span>}
                                <AlignmentDelta moral={event.moral_weight} ethical={event.ethical_weight} />
                            </div>
                        </div>
                        {actions && (
                            <div className="event-list__actions">
                                <button
                                    type="button"
                                    className="icon-button"
                                    aria-label={t.events.edit}
                                    title={t.events.edit}
                                    onClick={() => actions.onEdit(event)}
                                >
                                    <Icon name="edit" />
                                </button>
                                <button
                                    type="button"
                                    className="icon-button icon-button--danger"
                                    aria-label={t.events.delete}
                                    title={t.events.delete}
                                    onClick={() => actions.onDelete(event)}
                                >
                                    <Icon name="trash" />
                                </button>
                            </div>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}
