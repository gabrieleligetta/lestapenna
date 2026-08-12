import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiFetch } from '../api/client';
import { useSessionDetail } from '../api/hooks';
import type { SessionDetail, SessionRef, SessionSummary } from '../api/types';
import { ErrorState, Loading } from '../components/StateViews';
import { MEDIA } from '../breakpoints';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useLocale, useT } from '../i18n';
import './sessions.css';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/icons';
import { formatSessionTimestamp } from './sessionPresentation';
import { EntityThumbnail } from '../components/EntityMedia';
import { entityImageFrom } from '../components/entityMediaModel';
import { InventoryNameCell } from '../components/InventoryNameCell';

type TurnDirection = 'previous' | 'next';

function Narrative({ text }: { text: string }) {
    const paragraphs = text.split(/\n\s*\n/).filter(Boolean);
    return (
        <div className="session-narrative">
            {paragraphs.map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
            ))}
        </div>
    );
}

function ReferenceList<T extends SessionRef>({
    title,
    items,
    children,
    href,
}: {
    title: string;
    items: T[];
    children: (item: T) => ReactNode;
    href: (item: T) => string | null;
}) {
    if (items.length === 0) return null;
    return (
        <section className="session-reference-group">
            <h3>{title}</h3>
            <ul>
                {items.map((item, index) => {
                    const to = href(item);
                    return <li key={`${item.short_id ?? 'reference'}-${index}`}>{to ? <Link to={to}>{children(item)}</Link> : children(item)}</li>;
                })}
            </ul>
        </section>
    );
}

function splitNarrative(text: string): [string, string] {
    const paragraphs = text.trim().split(/\n\s*\n/).filter(Boolean);
    if (paragraphs.length > 1) {
        const target = text.length * 0.58;
        let bestBoundary = 1;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let boundary = 1; boundary < paragraphs.length; boundary += 1) {
            const length = paragraphs.slice(0, boundary).join('\n\n').length;
            const distance = Math.abs(length - target);
            if (distance < bestDistance) {
                bestBoundary = boundary;
                bestDistance = distance;
            }
        }
        return [
            paragraphs.slice(0, bestBoundary).join('\n\n'),
            paragraphs.slice(bestBoundary).join('\n\n'),
        ];
    }

    // A generated chronicle can occasionally arrive as one very long
    // paragraph. Prefer a sentence boundary over cutting prose mid-sentence.
    const sentences = text.match(/[^.!?…]+[.!?…]+(?:["'”’»]+)?|[^.!?…]+$/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
    if (sentences.length > 1) {
        const target = text.length * 0.58;
        let bestBoundary = 1;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let boundary = 1; boundary < sentences.length; boundary += 1) {
            const length = sentences.slice(0, boundary).join(' ').length;
            const distance = Math.abs(length - target);
            if (distance < bestDistance) {
                bestBoundary = boundary;
                bestDistance = distance;
            }
        }
        return [
            sentences.slice(0, bestBoundary).join(' '),
            sentences.slice(bestBoundary).join(' '),
        ];
    }

    return [text, ''];
}

function SessionSupport({
    session,
    campaignId,
    base,
}: {
    session: SessionDetail;
    campaignId: string;
    base: string;
}) {
    const { locale } = useLocale();
    const t = useT();
    const npcs = session.npcsEncountered ?? [];
    const quests = session.quests ?? [];
    const inventory = session.inventory ?? [];
    const bestiary = session.bestiary ?? [];
    const travels = session.travels ?? [];
    const notes = session.notes ?? [];
    const participants = session.participants ?? [];
    const audioUrl = `/api/v1/campaigns/${encodeURIComponent(campaignId)}/sessions/${encodeURIComponent(session.session_id)}/audio`;
    const audioStatusId = `session-audio-status-${session.session_id}`;

    return (
        <>
            {participants.length > 0 && (
                <section className="session-reference-group session-support-section">
                    <h2>{t.sessions.participants}</h2>
                    <ul>
                        {participants.map((participant) => (
                            <li key={participant.userId}>
                                <Link to={`${base}/characters/${participant.userId}`}>
                                    <span className="inline-reference">
                                        <EntityThumbnail
                                            image={participant.image}
                                            icon="characters"
                                            shape="portrait"
                                        />
                                        <span>{participant.characterName ?? participant.userId}</span>
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {(npcs.length > 0 || quests.length > 0 || inventory.length > 0 || bestiary.length > 0 || travels.length > 0) && (
                <section className="session-support-section">
                    <h2>{t.sessions.references}</h2>
                    <div className="session-reference-grid">
                        <ReferenceList
                            title={t.entities.npcs}
                            items={npcs}
                            href={(npc) => (npc.short_id ? `${base}/npcs/${npc.short_id}` : null)}
                        >
                            {(npc) => (
                                <span className="inline-reference">
                                    <EntityThumbnail
                                        image={entityImageFrom(npc.image)}
                                        icon="npcs"
                                        shape="portrait"
                                    />
                                    <span>{npc.name}</span>
                                </span>
                            )}
                        </ReferenceList>
                        <ReferenceList
                            title={t.entities.quests}
                            items={quests}
                            href={(quest) => (quest.short_id ? `${base}/quests/${quest.short_id}` : null)}
                        >
                            {(quest) => (
                                <span className="inline-reference">
                                    <span>{quest.title}</span>
                                    <StatusBadge status={quest.status} />
                                </span>
                            )}
                        </ReferenceList>
                        <ReferenceList
                            title={t.entities.inventory}
                            items={inventory}
                            href={(item) => (item.short_id ? `${base}/inventory/${item.short_id}` : null)}
                        >
                            {(item) => (
                                <span className="inline-reference">
                                    <InventoryNameCell row={item} />
                                    <span>×{item.quantity}</span>
                                </span>
                            )}
                        </ReferenceList>
                        <ReferenceList
                            title={t.entities.bestiary}
                            items={bestiary}
                            href={(creature) => (creature.short_id ? `${base}/bestiary/${creature.short_id}` : null)}
                        >
                            {(creature) => creature.name}
                        </ReferenceList>
                        {travels.length > 0 && (
                            <section className="session-reference-group">
                                <h3>{t.entities.locations}</h3>
                                <ul>
                                    {travels.map((travel, index) => (
                                        <li key={`${travel.timestamp}-${index}`}>
                                            {travel.macro_location} · {travel.micro_location}
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        )}
                    </div>
                </section>
            )}

            {notes.length > 0 && (
                <section className="session-support-section">
                    <h2>{t.sessions.notes}</h2>
                    <ul className="session-note-list">
                        {notes.map((note) => (
                            <li key={note.id}>
                                <p>{note.content}</p>
                                <time>{formatSessionTimestamp(note.timestamp, locale, true)}</time>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {session.media && (
                <section className="session-support-section session-media">
                    <h2>{t.sessions.media}</h2>
                    <div className="session-media__actions">
                        <div
                            className={`session-audio-player${session.media.audioAvailable ? '' : ' session-audio-player--unavailable'}`}
                        >
                            <audio
                                controls
                                preload="metadata"
                                src={session.media.audioAvailable ? audioUrl : undefined}
                                aria-label={t.sessions.audio}
                                aria-describedby={session.media.audioAvailable ? undefined : audioStatusId}
                            >
                                {session.media.audioAvailable && (
                                    <a href={audioUrl}>{t.sessions.audio}</a>
                                )}
                            </audio>
                            {!session.media.audioAvailable && (
                                <p id={audioStatusId} className="session-audio-player__status">
                                    {t.sessions.audioUnavailable}
                                </p>
                            )}
                        </div>
                        {session.media.transcriptAvailable && (
                            <Link
                                className="session-media-button"
                                to={`${base}/sessions/${session.session_id}/transcript`}
                            >
                                <Icon name="generic" />
                                {t.sessions.showTranscript}
                            </Link>
                        )}
                    </div>
                </section>
            )}
        </>
    );
}

function SessionSpread({
    session,
    campaignId,
    base,
    isDesktop,
    titleRef,
}: {
    session: SessionDetail;
    campaignId: string;
    base: string;
    isDesktop: boolean;
    titleRef: React.RefObject<HTMLHeadingElement | null>;
}) {
    const { locale } = useLocale();
    const t = useT();
    const title = session.title ?? t.sessions.untitled;
    const [firstNarrativePage, secondNarrativePage] = splitNarrative(session.narrative ?? '');
    const timestamp = session.start_time < 100_000_000_000 ? session.start_time * 1_000 : session.start_time;

    const header = (
        <header className="session-page-header">
            <p className="sessions-eyebrow">
                {session.session_number == null
                    ? t.sessions.eyebrow
                    : t.sessions.sessionNumber(session.session_number)}
            </p>
            <h1 ref={titleRef} tabIndex={-1}>{title}</h1>
            <time dateTime={new Date(timestamp).toISOString()}>
                {formatSessionTimestamp(session.start_time, locale)}
            </time>
        </header>
    );

    const brief = session.brief ? (
        <section className="session-brief">
            <h2>{t.sessions.brief}</h2>
            <p>{session.brief}</p>
        </section>
    ) : null;

    return (
        <article className="session-book" aria-label={title}>
            {isDesktop && (
                <div className="session-book__left">
                    <div className="session-book-page session-book-page--left">
                        {header}
                        {brief}
                        {firstNarrativePage && (
                            <section className="session-chronicle">
                                <h2>{t.sessions.chronicle}</h2>
                                <Narrative text={firstNarrativePage} />
                            </section>
                        )}
                    </div>
                </div>
            )}
            <div className="session-book__right">
                <div className="session-book-page session-book-page--right">
                    {!isDesktop && header}
                    {!isDesktop && brief}
                    {(isDesktop ? secondNarrativePage : session.narrative) && (
                        <section className={`session-chronicle${isDesktop ? ' session-chronicle--continued' : ''}`}>
                            <h2>{t.sessions.chronicle}</h2>
                            <Narrative text={(isDesktop ? secondNarrativePage : session.narrative) ?? ''} />
                        </section>
                    )}
                    <SessionSupport session={session} campaignId={campaignId} base={base} />
                </div>
            </div>
        </article>
    );
}

export function SessionReaderPage() {
    const { guildId = '', campaignId = '', sessionId = '' } = useParams();
    const { data: session, isLoading, isError, error } = useSessionDetail(campaignId, sessionId);
    const isDesktop = useMediaQuery(MEDIA.xl);
    const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const t = useT();
    const base = `/guilds/${guildId}/campaigns/${campaignId}`;
    const indexUrl = `${base}/sessions`;
    const headingRef = useRef<HTMLHeadingElement>(null);
    const lastFocusedSession = useRef(sessionId);
    const timers = useRef<number[]>([]);
    const [turning, setTurning] = useState<TurnDirection | null>(null);
    const [preparing, setPreparing] = useState(false);

    useEffect(
        () => () => {
            for (const timer of timers.current) window.clearTimeout(timer);
        },
        [],
    );

    useEffect(() => {
        if (!session || lastFocusedSession.current === session.session_id) return;
        lastFocusedSession.current = session.session_id;
        headingRef.current?.focus({ preventScroll: true });
    }, [session]);

    if (isLoading) return <Loading />;
    if (isError || !session) return <ErrorState error={error} />;

    const navigateWithTurn = async (
        event: MouseEvent<HTMLAnchorElement>,
        target: SessionSummary,
        direction: TurnDirection,
    ) => {
        if (
            reducedMotion ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
        ) {
            return;
        }
        event.preventDefault();
        if (turning || preparing) return;
        setPreparing(true);
        const targetUrl = `${indexUrl}/${target.session_id}`;

        try {
            await queryClient.ensureQueryData({
                queryKey: ['campaigns', campaignId, 'sessions', target.session_id],
                queryFn: () =>
                    apiFetch<SessionDetail>(`/campaigns/${campaignId}/sessions/${target.session_id}`),
            });
        } catch {
            setPreparing(false);
            navigate(targetUrl);
            return;
        }

        setPreparing(false);
        setTurning(direction);
        timers.current.push(
            window.setTimeout(() => navigate(targetUrl), 240),
            window.setTimeout(() => setTurning(null), 480),
        );
    };

    const previous = session.navigation?.previous ?? null;
    const next = session.navigation?.next ?? null;
    const controlsDisabled = turning !== null || preparing;

    return (
        <div
            className={`session-reader${turning ? ` is-turning-${turning}` : ''}`}
            aria-busy={preparing}
        >
            {preparing && (
                <span className="visually-hidden" role="status" aria-live="polite">
                    {t.common.loading}
                </span>
            )}
            <nav className="session-reader-controls" aria-label={t.sessions.readerNavigation}>
                <Link to={indexUrl}>{t.sessions.index}</Link>
            </nav>

            <div className="session-book-stage">
                {previous ? (
                    <Link
                        className="session-page-arrow session-page-arrow--previous"
                        to={`${indexUrl}/${previous.session_id}`}
                        aria-disabled={controlsDisabled}
                        aria-label={t.sessions.previousSession}
                        onClick={(event) => void navigateWithTurn(event, previous, 'previous')}
                    >
                        <Icon name="arrowLeft" />
                    </Link>
                ) : (
                    <span className="session-page-arrow-placeholder" aria-hidden="true" />
                )}

                <div className="session-book-frame">
                    <SessionSpread
                        session={session}
                        campaignId={campaignId}
                        base={base}
                        isDesktop={isDesktop}
                        titleRef={headingRef}
                    />
                    {!next && (
                        <span className="session-book__closing-edge">
                            <span className="visually-hidden">{t.sessions.endOfChronicle}</span>
                        </span>
                    )}
                    {turning && (
                        <div className={`session-turning-page session-turning-page--${turning}`} aria-hidden="true">
                            <span className="session-turning-page__front" />
                            <span className="session-turning-page__back" />
                        </div>
                    )}
                </div>

                {next ? (
                    <Link
                        className="session-page-arrow session-page-arrow--next"
                        to={`${indexUrl}/${next.session_id}`}
                        aria-disabled={controlsDisabled}
                        aria-label={t.sessions.nextSession}
                        onClick={(event) => void navigateWithTurn(event, next, 'next')}
                    >
                        <Icon name="arrowRight" />
                    </Link>
                ) : (
                    <span className="session-page-arrow-placeholder" aria-hidden="true" />
                )}
            </div>
        </div>
    );
}
