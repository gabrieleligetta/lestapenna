import { useRef, useState, type CSSProperties, type KeyboardEvent, type UIEvent } from 'react';
import { Link } from 'react-router-dom';
import type { CampaignSummary } from '../api/types';
import { Badge } from './Badge';
import { Icon } from './icons';
import './CampaignJournalCarousel.css';

export interface CampaignJournalCarouselLabels {
    carousel: string;
    previous: string;
    next: string;
    active: string;
    year: string;
    location: string;
}

interface CampaignJournalCarouselProps {
    campaigns: CampaignSummary[];
    guildId: string;
    labels: CampaignJournalCarouselLabels;
}

const COVER_VARIANTS = 6;

function monogram(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '✦';
    if (words.length === 1) return Array.from(words[0]).slice(0, 2).join('').toLocaleUpperCase();
    return `${Array.from(words[0])[0]}${Array.from(words.at(-1) ?? '')[0]}`.toLocaleUpperCase();
}

function campaignLocation(campaign: CampaignSummary): string {
    const parts = [campaign.currentLocation?.macro, campaign.currentLocation?.micro].filter(
        (part): part is string => Boolean(part),
    );
    return parts.length > 0 ? parts.join(' — ') : '—';
}

function prefersReducedMotion(): boolean {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function leadingPadding(track: HTMLElement): number {
    const value = Number.parseFloat(window.getComputedStyle(track).paddingInlineStart);
    return Number.isFinite(value) ? value : 0;
}

export function CampaignJournalCarousel({ campaigns, guildId, labels }: CampaignJournalCarouselProps) {
    const trackRef = useRef<HTMLOListElement>(null);
    const [currentIndex, setCurrentIndex] = useState(0);
    const lastIndex = campaigns.length - 1;

    const goTo = (requestedIndex: number, moveFocus = false) => {
        const nextIndex = Math.min(Math.max(requestedIndex, 0), lastIndex);
        const track = trackRef.current;
        const item = track?.querySelectorAll<HTMLElement>('[data-campaign-journal]')[nextIndex];

        setCurrentIndex(nextIndex);
        if (track && item) {
            const trackRect = track.getBoundingClientRect();
            const itemRect = item.getBoundingClientRect();
            const alignedLeft =
                track.scrollLeft +
                (itemRect.left - trackRect.left) -
                leadingPadding(track);

            track.scrollTo?.({
                left: Math.max(0, alignedLeft),
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
        const trackRect = track.getBoundingClientRect();
        const viewportStart = trackRect.left + leadingPadding(track);
        items.forEach((item, index) => {
            const itemRect = item.getBoundingClientRect();
            const distance = Math.abs(itemRect.left - viewportStart);
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
                aria-label={labels.carousel}
                onKeyDown={handleKeyDown}
                onScroll={handleScroll}
            >
                {campaigns.map((campaign, index) => {
                    const variant = Math.abs(campaign.id) % COVER_VARIANTS;
                    const coverStyle = {
                        '--journal-origin': `${25 + variant * 5}%`,
                        '--journal-angle': `${28 + variant * 9}deg`,
                    } as CSSProperties;

                    return (
                        <li
                            className="campaign-journals__item"
                            data-campaign-journal
                            key={campaign.id}
                        >
                            <Link
                                to={`/guilds/${guildId}/campaigns/${campaign.id}`}
                                className={`campaign-journal campaign-journal--${variant}${
                                    campaign.isActive ? ' is-active' : ''
                                }`}
                                style={coverStyle}
                                tabIndex={index === currentIndex ? 0 : -1}
                                aria-current={index === currentIndex ? 'true' : undefined}
                                onFocus={() => setCurrentIndex(index)}
                            >
                                <span className="campaign-journal__ornament" aria-hidden="true">
                                    <span>✦</span>
                                </span>
                                <span className="campaign-journal__monogram" aria-hidden="true">
                                    {monogram(campaign.name)}
                                </span>
                                <span className="campaign-journal__title">{campaign.name}</span>
                                {campaign.isActive && (
                                    <span className="campaign-journal__status">
                                        <Badge tone="success">{labels.active}</Badge>
                                    </span>
                                )}
                                <span className="campaign-journal__meta">
                                    <span>
                                        <span className="campaign-journal__meta-label">{labels.year}</span>
                                        <span>{campaign.currentYear ?? '—'}</span>
                                    </span>
                                    <span>
                                        <span className="campaign-journal__meta-label">{labels.location}</span>
                                        <span>{campaignLocation(campaign)}</span>
                                    </span>
                                </span>
                            </Link>
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
