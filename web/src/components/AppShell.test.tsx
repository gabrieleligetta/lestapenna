import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router-dom';
import { AppShell } from './AppShell';
import { renderRoutes } from '../test/renderWithProviders';
import { server, jsonGet } from '../test/server';

const OVERVIEW = {
    id: 1,
    name: 'Ashes of Vaelor',
    currentYear: 1492,
    currentLocation: { macro: 'Neverwinter', micro: 'The Docks' },
    partyAlignment: { moral: null, ethical: null },
    party: [{ userId: 'u1', name: 'Helena', race: 'Human', class: 'Bard' }],
    lastSession: null,
    counts: {
        sessions: 12,
        openQuests: 3,
        npcs: 47,
        locations: 21,
        factions: 5,
        inventory: 9,
        artifacts: 2,
        bestiary: 31,
    },
};

const ROUTE = '/guilds/g1/campaigns/1';

function renderShell(route = ROUTE) {
    return renderRoutes(
        <Route element={<AppShell />}>
            <Route path="/guilds/:guildId/campaigns/:campaignId" element={<p>campaign page</p>} />
            <Route path="/guilds/:guildId/campaigns/:campaignId/:entityType" element={<p>list page</p>} />
            <Route
                path="/guilds/:guildId/campaigns/:campaignId/sessions/:sessionId/transcript"
                element={<p>transcript page</p>}
            />
        </Route>,
        { route },
    );
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

beforeAll(() => {
    server.use(
        jsonGet('/campaigns/1', OVERVIEW),
        jsonGet('/guilds/g1', { id: 'g1', name: 'The Long Rest', icon: null, canManage: false }),
        jsonGet('/me/guilds', [{ id: 'g1', name: 'The Long Rest', icon: null, canManage: false }]),
        jsonGet('/guilds/g1/campaigns', [
            { id: 1, name: 'Ashes of Vaelor', isActive: true, currentYear: 1492, currentLocation: null, language: 'en' },
        ]),
        jsonGet('/campaigns/1/sessions/s2', {
            session_id: 's2',
            title: 'The glass tower',
        }),
    );
});

afterEach(() => localStorage.clear());
afterAll(() => server.close());

describe('AppShell', () => {
    it('uses the Lestapenna mark in the application header', () => {
        const { container } = renderShell();
        expect(container.querySelector('.brand-mark')).toHaveAttribute(
            'src',
            `${import.meta.env.BASE_URL}assets/mark.svg`,
        );
    });

    it('carries the support bar inside the shell, so a dialog takes it away too', async () => {
        const { container } = renderShell();

        const bar = await screen.findByRole('contentinfo');
        // Inside `.app-shell` and not beside it: the shell is what gets `inert`
        // when a modal opens, and a footer left outside would stay tabbable
        // underneath it.
        expect(container.querySelector('.app-shell')).toContainElement(bar);
    });

    it('keeps the closed drawer out of the tab order', async () => {
        renderShell();

        // Not merely translated off-screen: without `inert` the links stay
        // focusable and a keyboard user tabs into an invisible menu.
        const sidebar = document.getElementById('app-sidebar');
        expect(sidebar).toHaveAttribute('inert');

        await userEvent.click(screen.getByRole('button', { name: 'Open menu' }));
        expect(sidebar).not.toHaveAttribute('inert');
        expect(screen.getByRole('dialog', { name: 'Campaign' })).toHaveAttribute('aria-modal', 'true');
    });

    it('closes the drawer on Escape and gives focus back to the toggle', async () => {
        renderShell();
        const toggle = screen.getByRole('button', { name: 'Open menu' });

        await userEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(
            screen.getByRole('dialog', { name: 'Campaign' }).querySelector('[data-drawer-close]'),
        ).toHaveFocus();

        await userEvent.keyboard('{Escape}');
        expect(screen.getByRole('button', { name: 'Open menu' })).toHaveAttribute('aria-expanded', 'false');
        expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus();
    });

    it('names the whole trail, not just the parent', async () => {
        renderShell(`${ROUTE}/npcs`);

        // Scoped to the nav: the switcher renders the same two names as <option>s,
        // so an unscoped query matches twice.
        const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
        expect(await within(crumbs).findByText('The Long Rest')).toBeInTheDocument();
        expect(await within(crumbs).findByText('Ashes of Vaelor')).toBeInTheDocument();
        expect(crumbs).toHaveTextContent('NPCs');
    });

    it('keeps the session as a link when the transcript is the current page', async () => {
        renderShell(`${ROUTE}/sessions/s2/transcript`);

        const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
        expect(await within(crumbs).findByRole('link', { name: 'The glass tower' })).toHaveAttribute(
            'href',
            `${ROUTE}/sessions/s2`,
        );
        expect(within(crumbs).getByText('Transcript').closest('li')).toHaveAttribute(
            'aria-current',
            'page',
        );
    });

    it('shows the counts the overview already carries', async () => {
        renderShell();
        // Read from the same query key CampaignLayout uses, so this costs no extra request.
        expect(await screen.findByText('47')).toBeInTheDocument();
    });

    it('cycles the theme and remembers the choice', async () => {
        renderShell();
        const toggle = screen.getByRole('button', { name: /Theme/ });

        // system -> light -> dark
        await userEvent.click(toggle);
        await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'light'));
        expect(localStorage.getItem('lp_theme')).toBe('light');

        await userEvent.click(screen.getByRole('button', { name: /Theme/ }));
        await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'dark'));
        expect(localStorage.getItem('lp_theme')).toBe('dark');
    });
});
