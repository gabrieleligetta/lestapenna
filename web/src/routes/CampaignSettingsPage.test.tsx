import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CampaignSettingsPage } from './CampaignSettingsPage';
import { CampaignsPage } from './CampaignsPage';
import { renderWithProviders } from '../test/renderWithProviders';
import { campaignOverview, http, HttpResponse, jsonGet, server } from '../test/server';
import type { CampaignMember, CampaignSettings } from '../api/types';

const SETTINGS: CampaignSettings = {
    id: 1,
    name: 'Ashes of Vaelor',
    language: 'it',
    current_year: 1482,
    party_name: 'The Ashen Hand',
    allow_auto_character_update: false,
    art_direction: null,
    tarot_arcana: 'hermit',
    cover_url: null,
};

const MEMBERS: CampaignMember[] = [
    {
        user_id: 'u-master',
        role: 'MASTER',
        character_name: null,
        display_name: 'Vaelor',
        username: 'vaelor',
        enrolled: true,
        added_at: 1,
    },
    {
        user_id: 'u-player',
        role: 'PLAYER',
        character_name: 'Aria',
        display_name: 'Ariadne',
        username: 'ariadne',
        enrolled: true,
        added_at: 2,
    },
];

const ROUTE = '/guilds/g1/campaigns/1/settings';
const PATH = '/guilds/:guildId/campaigns/:campaignId/settings';

describe('CampaignSettingsPage', () => {
    beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
    afterEach(() => server.resetHandlers());
    afterAll(() => server.close());

    it('mostra e salva le impostazioni del mondo', async () => {
        const user = userEvent.setup();
        let patched: Record<string, unknown> | null = null;
        server.use(
            campaignOverview(1),
            jsonGet('/campaigns/1/settings', SETTINGS),
            jsonGet('/campaigns/1/members', MEMBERS),
            http.patch('/api/v1/campaigns/1/settings', async ({ request }) => {
                patched = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json({ ...SETTINGS, current_year: 1499 });
            }),
        );
        renderWithProviders(<CampaignSettingsPage />, { route: ROUTE, path: PATH });

        const year = await screen.findByLabelText('Current year');
        await user.clear(year);
        await user.type(year, '1499');
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(patched).toMatchObject({ current_year: 1499, name: 'Ashes of Vaelor' }));
        expect(await screen.findByText('Saved.')).toBeInTheDocument();
    });

    it('promuove un membro e chiede conferma prima di rimuoverlo', async () => {
        const user = userEvent.setup();
        let promoted: Record<string, unknown> | null = null;
        let removed = false;
        server.use(
            campaignOverview(1),
            jsonGet('/campaigns/1/settings', SETTINGS),
            jsonGet('/campaigns/1/members', MEMBERS),
            http.patch('/api/v1/campaigns/1/members/u-player', async ({ request }) => {
                promoted = (await request.json()) as Record<string, unknown>;
                return new HttpResponse(null, { status: 204 });
            }),
            http.delete('/api/v1/campaigns/1/members/u-player', () => {
                removed = true;
                return new HttpResponse(null, { status: 204 });
            }),
        );
        renderWithProviders(<CampaignSettingsPage />, { route: ROUTE, path: PATH });

        await user.click(await screen.findByRole('button', { name: 'Make master' }));
        await waitFor(() => expect(promoted).toEqual({ role: 'MASTER' }));

        const playerRow = screen.getByText('Ariadne').closest('li')!;
        await user.click(within(playerRow).getByRole('button', { name: 'Remove' }));
        // Removal goes through an explicit confirmation, which also says what is NOT
        // deleted.
        expect(await screen.findByText(/Their character is kept/)).toBeInTheDocument();
        expect(removed).toBe(false);

        const dialog = screen.getByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
        await waitFor(() => expect(removed).toBe(true));
    });

    it('lists a character owner with no seat and lets the master enrol them', async () => {
        const user = userEvent.setup();
        let enrolled: Record<string, unknown> | null = null;
        server.use(
            campaignOverview(1),
            jsonGet('/campaigns/1/settings', SETTINGS),
            jsonGet('/campaigns/1/members', [
                ...MEMBERS,
                {
                    user_id: 'u-guest',
                    role: 'PLAYER',
                    character_name: 'Tommy',
                    display_name: 'tommaso',
                    username: 'tommaso',
                    enrolled: false,
                    added_at: null,
                } satisfies CampaignMember,
            ]),
            http.patch('/api/v1/campaigns/1/members/u-guest', async ({ request }) => {
                enrolled = (await request.json()) as Record<string, unknown>;
                return new HttpResponse(null, { status: 204 });
            }),
        );
        renderWithProviders(<CampaignSettingsPage />, { route: ROUTE, path: PATH });

        // The Discord name is the label; the character is the secondary line.
        const guestRow = (await screen.findByText('tommaso')).closest('li')!;
        expect(within(guestRow).getByText(/Tommy/)).toBeInTheDocument();
        expect(within(guestRow).getByText('Not enrolled')).toBeInTheDocument();

        await user.click(within(guestRow).getByRole('button', { name: 'Add to the table' }));
        await waitFor(() => expect(enrolled).toEqual({ role: 'PLAYER' }));
    });

    it('changes the campaign card from the settings, one click per arcanum', async () => {
        const user = userEvent.setup();
        let patched: Record<string, unknown> | null = null;
        server.use(
            campaignOverview(1),
            jsonGet('/campaigns/1/settings', SETTINGS),
            jsonGet('/campaigns/1/members', MEMBERS),
            http.patch('/api/v1/campaigns/1/settings', async ({ request }) => {
                patched = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json({ ...SETTINGS, tarot_arcana: 'tower' });
            }),
        );
        renderWithProviders(<CampaignSettingsPage />, { route: ROUTE, path: PATH });

        // The card it was dealt is the one already chosen.
        const deck = await screen.findByRole('radiogroup', { name: 'Major arcanum' });
        expect(within(deck).getByRole('radio', { name: /The Hermit/ })).toBeChecked();

        await user.click(within(deck).getByRole('radio', { name: /The Tower/ }));
        await waitFor(() => expect(patched).toEqual({ tarot_arcana: 'tower' }));
    });

    it('nega la modifica a chi non è master', async () => {
        server.use(
            campaignOverview(1, { myRole: 'PLAYER', canWrite: true, canManageMembers: false }),
            jsonGet('/campaigns/1/settings', SETTINGS),
            jsonGet('/campaigns/1/members', MEMBERS),
        );
        renderWithProviders(<CampaignSettingsPage />, { route: ROUTE, path: PATH });

        expect(await screen.findByText('Only a master can change this.')).toBeInTheDocument();
        expect(screen.getByLabelText('Campaign name')).toBeDisabled();
        expect(screen.queryByRole('button', { name: 'Make master' })).not.toBeInTheDocument();
    });
});

describe('CampaignsPage — creazione', () => {
    beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
    afterEach(() => server.resetHandlers());
    afterAll(() => server.close());

    it('crea una campagna dal sito e ci atterra sopra', async () => {
        const user = userEvent.setup();
        let created: Record<string, unknown> | null = null;
        server.use(
            jsonGet('/guilds/g1', { id: 'g1', name: 'Table', icon: null, canManage: true }),
            jsonGet('/guilds/g1/campaigns', []),
            http.post('/api/v1/guilds/g1/campaigns', async ({ request }) => {
                created = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json({
                    id: 42, name: 'New Campaign', isActive: false,
                    currentYear: null, currentLocation: null, language: 'en',
                }, { status: 201 });
            }),
        );
        renderWithProviders(<CampaignsPage />, {
            route: '/guilds/g1/campaigns',
            path: '/guilds/:guildId/campaigns',
        });

        // The empty state is a call to action, not a dead end.
        await user.click(await screen.findByRole('button', { name: 'Create the first campaign of this server.' }));
        await user.type(screen.getByLabelText('Campaign name'), 'New Campaign');
        await user.click(screen.getByRole('button', { name: 'Create campaign' }));

        await waitFor(() => expect(created).toMatchObject({ name: 'New Campaign' }));
    });
});
