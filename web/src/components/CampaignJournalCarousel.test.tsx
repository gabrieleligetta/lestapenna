import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CampaignSummary } from '../api/types';
import { renderWithProviders } from '../test/renderWithProviders';
import { CampaignJournalCarousel, type CampaignJournalCarouselLabels } from './CampaignJournalCarousel';

const CAMPAIGNS: CampaignSummary[] = [
    {
        id: 7,
        name: 'The Ember Crown',
        isActive: true,
        currentYear: 1492,
        currentLocation: { macro: 'Sword Coast', micro: 'Neverwinter' },
        language: 'en',
        tarotArcanum: 'tower',
        coverUrl: '/api/v1/campaigns/7/cover/thumbnail',
        canWrite: true,
    },
    {
        id: 11,
        name: 'Shadows of Barovia',
        isActive: false,
        currentYear: null,
        currentLocation: { macro: 'Barovia', micro: null },
        language: 'en',
        tarotArcanum: 'moon',
        coverUrl: null,
        canWrite: false,
    },
    {
        id: 18,
        name: 'Salt and Starlight',
        isActive: false,
        currentYear: 302,
        currentLocation: null,
        language: 'en',
        tarotArcanum: 'star',
        coverUrl: null,
        canWrite: false,
    },
];

const LABELS: CampaignJournalCarouselLabels = {
    carousel: 'Campaigns',
    previous: 'Previous',
    next: 'Next',
    active: 'Active',
    year: 'Year',
    location: 'Location',
    arcanumName: (arcanum) => ({ tower: 'The Tower', moon: 'The Moon', star: 'The Star' } as Record<string, string>)[arcanum] ?? arcanum,
    coverAlt: (name) => `Cover of ${name}`,
};

function renderCarousel() {
    return renderWithProviders(
        <CampaignJournalCarousel campaigns={CAMPAIGNS} guildId="guild-42" labels={LABELS} />,
    );
}

describe('CampaignJournalCarousel', () => {
    it('keeps campaigns as a real ordered list of real links', () => {
        renderCarousel();

        expect(screen.getByRole('list', { name: 'Campaigns' }).tagName).toBe('OL');
        expect(screen.getAllByRole('listitem')).toHaveLength(3);
        expect(screen.getByRole('link', { name: /The Ember Crown/ })).toHaveAttribute(
            'href',
            '/guilds/guild-42/campaigns/7',
        );
        expect(screen.getByRole('link', { name: /Shadows of Barovia/ })).toHaveAttribute(
            'href',
            '/guilds/guild-42/campaigns/11',
        );
    });

    it('renders the campaign state, year and most specific available location', () => {
        renderCarousel();

        expect(screen.getByText('Active')).toBeInTheDocument();
        expect(screen.getByText('1492')).toBeInTheDocument();
        expect(screen.getByText('Sword Coast — Neverwinter')).toBeInTheDocument();
        expect(screen.getByText('Barovia')).toBeInTheDocument();
    });

    it('moves with controls and disables them at the bounds', async () => {
        const user = userEvent.setup();
        renderCarousel();

        const previous = screen.getByRole('button', { name: 'Previous' });
        const next = screen.getByRole('button', { name: 'Next' });
        expect(previous).toBeDisabled();
        expect(screen.getByText('1 / 3')).toBeInTheDocument();

        await user.click(next);
        expect(previous).toBeEnabled();
        expect(screen.getByText('2 / 3')).toBeInTheDocument();

        await user.click(next);
        expect(next).toBeDisabled();
        expect(screen.getByText('3 / 3')).toBeInTheDocument();
    });

    it('brings the chosen card to the middle of the shelf, not to its left edge', async () => {
        const user = userEvent.setup();
        renderCarousel();

        const track = screen.getByRole('list', { name: 'Campaigns' });
        const journals = screen.getAllByRole('listitem');
        const scrollTo = vi.fn();
        Object.defineProperties(track, {
            clientWidth: { configurable: true, value: 600 },
            scrollLeft: { configurable: true, value: 120, writable: true },
            scrollTo: { configurable: true, value: scrollTo },
        });
        vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(new DOMRect(240, 0, 600, 420));
        vi.spyOn(journals[1], 'getBoundingClientRect').mockReturnValue(new DOMRect(760, 0, 280, 400));

        await user.click(screen.getByRole('button', { name: 'Next' }));

        // 120 + (760 - 240) - (600 - 280) / 2: the card ends up centred.
        expect(scrollTo).toHaveBeenCalledWith({
            left: 480,
            behavior: 'smooth',
        });
    });

    it('counts the card nearest the middle as the current one while scrolling', () => {
        renderCarousel();

        const track = screen.getByRole('list', { name: 'Campaigns' });
        const journals = screen.getAllByRole('listitem');
        Object.defineProperty(track, 'clientWidth', { configurable: true, value: 900 });
        vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 900, 420));
        vi.spyOn(journals[0], 'getBoundingClientRect').mockReturnValue(new DOMRect(-160, 0, 280, 400));
        // Exactly centred: 410 - 100 === (900 - 280) / 2.
        vi.spyOn(journals[1], 'getBoundingClientRect').mockReturnValue(new DOMRect(410, 0, 280, 400));
        vi.spyOn(journals[2], 'getBoundingClientRect').mockReturnValue(new DOMRect(706, 0, 280, 400));

        fireEvent.scroll(track);

        expect(screen.getByText('2 / 3')).toBeInTheDocument();
        expect(screen.getAllByRole('link')[1]).toHaveAttribute('aria-current', 'true');
    });

    it('draws each campaign as its arcanum, with the cover in the medallion when there is one', () => {
        renderCarousel();

        expect(screen.getByText('The Tower')).toBeInTheDocument();
        expect(screen.getByText('The Moon')).toBeInTheDocument();

        const cover = screen.getByRole('img', { name: 'Cover of The Ember Crown' });
        expect(cover).toHaveAttribute('src', '/api/v1/campaigns/7/cover/thumbnail');
        // A campaign with no cover shows the drawing of its arcanum instead,
        // and that is decoration: exactly one picture is announced to a screen
        // reader.
        expect(screen.getAllByRole('img')).toHaveLength(1);
    });

    it('supports arrow, Home and End keys without requiring drag gestures', () => {
        renderCarousel();
        const links = screen.getAllByRole('link');

        fireEvent.keyDown(links[0], { key: 'End' });
        expect(screen.getByText('3 / 3')).toBeInTheDocument();
        expect(links[2]).toHaveFocus();
        expect(links[2]).toHaveAttribute('aria-current', 'true');

        fireEvent.keyDown(links[2], { key: 'ArrowLeft' });
        expect(screen.getByText('2 / 3')).toBeInTheDocument();

        fireEvent.keyDown(links[1], { key: 'Home' });
        expect(screen.getByText('1 / 3')).toBeInTheDocument();

        fireEvent.keyDown(links[0], { key: 'ArrowRight' });
        expect(screen.getByText('2 / 3')).toBeInTheDocument();
        expect(links.map((link) => link.tabIndex)).toEqual([-1, 0, -1]);
    });
});
