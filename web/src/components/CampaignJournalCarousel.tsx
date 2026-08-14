import {
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties,
    type KeyboardEvent,
    type PointerEvent,
    type UIEvent,
} from 'react';
import { Link } from 'react-router-dom';
import type { CampaignSummary } from '../api/types';
import { Badge } from './Badge';
import { Icon } from './icons';
import { tarotFace, type TarotArcanum } from './tarot';
import { TarotArt } from './tarotArt';
import './CampaignJournalCarousel.css';

export interface CampaignJournalCarouselLabels {
    carousel: string;
    previous: string;
    next: string;
    active: string;
    year: string;
    location: string;
    /** The name of one arcanum, in the reader's language. */
    arcanumName: (arcanum: TarotArcanum) => string;
    coverAlt: (campaignName: string) => string;
}

interface CampaignJournalCarouselProps {
    campaigns: CampaignSummary[];
    guildId: string;
    labels: CampaignJournalCarouselLabels;
}

const COVER_VARIANTS = 6;

/** How long the whole hand takes to be dealt, so the last card is not a wait. */
const DEAL_STAGGER_MS = 120;
const MAX_DEAL_STAGGER_MS = 960;

function campaignLocation(campaign: CampaignSummary): string {
    const parts = [campaign.currentLocation?.macro, campaign.currentLocation?.micro].filter(
        (part): part is string => Boolean(part),
    );
    return parts.length > 0 ? parts.join(' — ') : '—';
}

function prefersReducedMotion(): boolean {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** How far a card leans towards the pointer, in degrees. */
const MAX_TILT_DEG = 7;

/**
 * The lean of a card under the pointer, and the light that moves with it.
 *
 * A printed card is a physical thing: tip it and the gilt catches the light
 * somewhere else. Written straight to custom properties rather than through
 * state — this fires on every pointer move, and a render per frame would be a
 * high price for a few degrees of lean.
 */
function tiltTowardsPointer(event: PointerEvent<HTMLElement>): void {
    if (prefersReducedMotion()) return;
    const card = event.currentTarget;
    const rect = card.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    card.style.setProperty('--tilt-y', `${(x * MAX_TILT_DEG * 2).toFixed(2)}deg`);
    card.style.setProperty('--tilt-x', `${(-y * MAX_TILT_DEG * 2).toFixed(2)}deg`);
    card.style.setProperty('--sheen-shift', `${(x * 60).toFixed(1)}%`);
}

function releaseTilt(event: PointerEvent<HTMLElement>): void {
    const card = event.currentTarget;
    card.style.removeProperty('--tilt-y');
    card.style.removeProperty('--tilt-x');
    card.style.removeProperty('--sheen-shift');
}

/**
 * How far the given card is from being centred in the shelf.
 *
 * Centre rather than leading edge: with two campaigns and a wide shelf, aligning
 * everything to the left padding left the pair hanging off the right-hand side
 * of an otherwise empty row — which is exactly what the page looked like when
 * somebody opened it.
 */
function offsetToCentre(track: HTMLElement, item: HTMLElement): number {
    const trackRect = track.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    return (itemRect.left - trackRect.left) - (trackRect.width - itemRect.width) / 2;
}

export function CampaignJournalCarousel({ campaigns, guildId, labels }: CampaignJournalCarouselProps) {
    const trackRef = useRef<HTMLOListElement>(null);
    const [currentIndex, setCurrentIndex] = useState(0);
    // Half a shelf minus half a card, on both ends — but only once the hand is
    // wider than the shelf. Without it the first and last card can never reach
    // the middle, because there is no room to scroll them there; with it always
    // on, a hand that fits would be shoved off to one side, which is the bug
    // this whole carousel was reported for.
    const [edgePadding, setEdgePadding] = useState(0);
    const lastIndex = campaigns.length - 1;

    useLayoutEffect(() => {
        const track = trackRef.current;
        if (!track || typeof ResizeObserver === 'undefined') return;

        const measure = () => {
            const items = track.querySelectorAll<HTMLElement>('[data-campaign-journal]');
            if (items.length === 0) return;
            const first = items[0].getBoundingClientRect();
            const last = items[items.length - 1].getBoundingClientRect();
            // The hand's own width: padding moves the cards but never widens
            // the group, so this measurement is stable across the change it
            // causes.
            const handWidth = last.right - first.left;
            setEdgePadding(
                handWidth > track.clientWidth ? Math.max(0, (track.clientWidth - first.width) / 2) : 0,
            );

            // Where the deck lies, and how far each card has to travel from it.
            // Written straight onto the element rather than through state: it is
            // a measurement of the layout, and feeding it back through a render
            // would only measure it again.
            const trackRect = track.getBoundingClientRect();
            const deck = trackRect.left + trackRect.width / 2;
            items.forEach((item) => {
                const rect = item.getBoundingClientRect();
                item.style.setProperty('--deal-from', `${Math.round(deck - (rect.left + rect.width / 2))}px`);
            });
        };

        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(track);
        return () => observer.disconnect();
    }, [campaigns.length]);

    const goTo = (requestedIndex: number, moveFocus = false) => {
        const nextIndex = Math.min(Math.max(requestedIndex, 0), lastIndex);
        const track = trackRef.current;
        const item = track?.querySelectorAll<HTMLElement>('[data-campaign-journal]')[nextIndex];

        setCurrentIndex(nextIndex);
        if (track && item) {
            track.scrollTo?.({
                left: Math.max(0, track.scrollLeft + offsetToCentre(track, item)),
                behavior: prefersReducedMotion() ? 'auto' : 'smooth',
            });
            if (moveFocus) item.querySelector<HTMLAnchorElement>('a')?.focus();
        }
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
        let nextIndex: number | undefined;
        if (event.key === 'ArrowLeft') nextIndex = currentIndex - 1;
        if (event.key === 'ArrowRight') nextIndex = currentIndex + 1;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = lastIndex;
        if (nextIndex === undefined) return;

        event.preventDefault();
        goTo(nextIndex, true);
    };

    const handleScroll = (event: UIEvent<HTMLOListElement>) => {
        const track = event.currentTarget;
        const items = Array.from(track.querySelectorAll<HTMLElement>('[data-campaign-journal]'));
        if (items.length === 0) return;

        let nearestIndex = 0;
        let nearestDistance = Number.POSITIVE_INFINITY;
        items.forEach((item, index) => {
            const distance = Math.abs(offsetToCentre(track, item));
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestIndex = index;
            }
        });
        setCurrentIndex(nearestIndex);
    };

    return (
        <section className="campaign-journals" aria-label={labels.carousel}>
            <ol
                ref={trackRef}
                className="campaign-journals__track"
                style={{ '--journal-edge-padding': `${edgePadding}px` } as CSSProperties}
                aria-label={labels.carousel}
                onKeyDown={handleKeyDown}
                onScroll={handleScroll}
            >
                {campaigns.map((campaign, index) => {
                    const variant = Math.abs(campaign.id) % COVER_VARIANTS;
                    const face = tarotFace(campaign.tarotArcanum);
                    const cardStyle = {
                        '--journal-origin': `${25 + variant * 5}%`,
                        '--journal-angle': `${28 + variant * 9}deg`,
                        // The hand is dealt left to right; a shelf of twenty
                        // campaigns must not make the last one wait a second.
                        '--deal-delay': `${Math.min(index * DEAL_STAGGER_MS, MAX_DEAL_STAGGER_MS)}ms`,
                    } as CSSProperties;

                    return (
                        <li
                            className="campaign-journals__item"
                            data-campaign-journal
                            key={campaign.id}
                            style={cardStyle}
                        >
                            {/* The dealing motion belongs to this wrapper, so the
                                card itself keeps its own hover and focus lift
                                instead of having them overwritten by an
                                animation that fills forwards. */}
                            <span className="tarot-deal">
                                <Link
                                    to={`/guilds/${guildId}/campaigns/${campaign.id}`}
                                    className={`tarot-card tarot-card--${variant}${
                                        campaign.isActive ? ' is-active' : ''
                                    }`}
                                    tabIndex={index === currentIndex ? 0 : -1}
                                    aria-current={index === currentIndex ? 'true' : undefined}
                                    onFocus={() => setCurrentIndex(index)}
                                    onPointerMove={tiltTowardsPointer}
                                    onPointerLeave={releaseTilt}
                                >
                                    {/* The back, face-up until the card turns
                                        over. It is the first thing the reader
                                        sees of a campaign — a card arriving
                                        already face-up has not been dealt, it
                                        has just appeared. */}
                                    <span className="tarot-card__back" aria-hidden="true" />
                                    <span className="tarot-card__front">
                                        <span className="tarot-card__numeral" aria-hidden="true">
                                            {face.numeral}
                                        </span>
                                        <span className="tarot-card__medallion" aria-hidden={!campaign.coverUrl}>
                                            {campaign.coverUrl ? (
                                                <img
                                                    className="tarot-card__cover"
                                                    src={campaign.coverUrl}
                                                    alt={labels.coverAlt(campaign.name)}
                                                    loading="lazy"
                                                />
                                            ) : (
                                                <TarotArt
                                                    className="tarot-card__art"
                                                    arcanum={face.key}
                                                />
                                            )}
                                        </span>
                                        <span className="tarot-card__title">{campaign.name}</span>
                                        {campaign.isActive && (
                                            <span className="tarot-card__status">
                                                <Badge tone="success">{labels.active}</Badge>
                                            </span>
                                        )}
                                        <span className="tarot-card__meta">
                                            <span>
                                                <span className="tarot-card__meta-label">{labels.year}</span>
                                                <span>{campaign.currentYear ?? '—'}</span>
                                            </span>
                                            <span>
                                                <span className="tarot-card__meta-label">{labels.location}</span>
                                                <span>{campaignLocation(campaign)}</span>
                                            </span>
                                        </span>
                                        {/* Where a printed card carries it:
                                            the numeral at the head, the name of
                                            the arcanum along the foot. */}
                                        <span className="tarot-card__arcanum">
                                            {labels.arcanumName(face.key)}
                                        </span>
                                    </span>
                                </Link>
                            </span>
                        </li>
                    );
                })}
            </ol>

            <div className="campaign-journals__controls">
                <button
                    className="campaign-journals__button"
                    type="button"
                    aria-label={labels.previous}
                    disabled={currentIndex === 0}
                    onClick={() => goTo(currentIndex - 1)}
                >
                    <Icon name="arrowLeft" />
                </button>
                <output className="campaign-journals__counter" aria-live="polite" aria-atomic="true">
                    {currentIndex + 1} / {campaigns.length}
                </output>
                <button
                    className="campaign-journals__button"
                    type="button"
                    aria-label={labels.next}
                    disabled={currentIndex === lastIndex}
                    onClick={() => goTo(currentIndex + 1)}
                >
                    <Icon name="arrowRight" />
                </button>
            </div>
        </section>
    );
}
