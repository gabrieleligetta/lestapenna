import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntityDetailPage } from './EntityDetailPage';
import { renderWithProviders } from '../test/renderWithProviders';
import { HttpResponse, http, jsonGet, pageOf, server, campaignOverview } from '../test/server';

const PATH = '/guilds/:guildId/campaigns/:campaignId/:entityType/:entityId';
const ROUTE = '/guilds/g1/campaigns/2/artifacts/a1';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('EntityDetailPage', () => {
    it('gives artifacts a dedicated readable layout with media fallback and history', async () => {
        server.use(
            jsonGet('/me', { id: 'u1', username: 'reader', globalName: null, avatar: null }),
            jsonGet('/guilds/g1', { id: 'g1', name: 'Guild', icon: null, canManage: false }),
            campaignOverview(2),
            jsonGet('/campaigns/2/artifacts/a1', {
                short_id: 'a1',
                name: 'Crown of Ash',
                description: 'An ancient crown whose long history must keep a comfortable reading measure.',
                effects: 'It reveals the last memory held by a flame.',
                is_cursed: 1,
                curse_description: 'Every vision leaves a trace of ash.',
                owner_type: 'PC',
                owner_name: 'Aria',
                location_macro: 'North',
                location_micro: 'Glass tower',
                status: 'FUNCTIONAL',
                last_updated: '2026-07-25',
            }),
            jsonGet('/campaigns/2/artifacts/a1/events', pageOf([])),
        );
        const { container } = renderWithProviders(<EntityDetailPage />, {
            route: ROUTE,
            path: PATH,
        });

        expect(await screen.findByRole('heading', { name: 'Crown of Ash', level: 1 })).toBeInTheDocument();
        expect(screen.getByText('Functional')).toBeInTheDocument();
        expect(screen.getByText(/long history must keep/)).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument();
        expect(container.querySelector('.artifact-prose')).toBeInTheDocument();
        expect(container.querySelector('.entity-media__fallback')).toBeInTheDocument();
    });

    /**
     * The image panel is not a caption under the portrait.
     *
     * It used to live inside `.entity-media-stack`, a 10.5rem column sized for a
     * 4:5 portrait — merely cramped while it held a dropzone, unusable once it
     * also held the generation form, which arrived as a column of single words
     * beside an empty half-screen (segnalazione #000016). It belongs in the
     * flow below the header, where it has the width of the text.
     */
    it('gives the image panel the width of the text, not of the portrait', async () => {
        server.use(
            jsonGet('/me', { id: 'u1', username: 'manager', globalName: null, avatar: null }),
            jsonGet('/guilds/g1', { id: 'g1', name: 'Guild', icon: null, canManage: true }),
            campaignOverview(2),
            jsonGet('/campaigns/2/artifacts/a1', {
                short_id: 'a1',
                name: 'Crown of Ash',
                description: 'An ancient crown.',
                is_cursed: 0,
                status: 'FUNCTIONAL',
                last_updated: '2026-07-25',
            }),
            jsonGet('/campaigns/2/artifacts/a1/events', pageOf([])),
        );
        const { container } = renderWithProviders(<EntityDetailPage />, { route: ROUTE, path: PATH });

        await screen.findByRole('heading', { name: 'Crown of Ash', level: 1 });

        const panel = container.querySelector('.entity-media-manager');
        expect(panel).toBeInTheDocument();
        expect(container.querySelector('.entity-media-stack .entity-media-manager')).toBeNull();
        // And the portrait stays in its column, where it belongs.
        expect(container.querySelector('.entity-media-stack .entity-media')).toBeInTheDocument();
    });

    it('renders a dedicated inventory detail and lets managers persist its category', async () => {
        const user = userEvent.setup();
        let category = 'OTHER';
        server.use(
            jsonGet('/me', { id: 'u1', username: 'manager', globalName: null, avatar: null }),
            jsonGet('/guilds/g1', { id: 'g1', name: 'Guild', icon: null, canManage: true }),
            campaignOverview(2),
            http.get('/api/v1/campaigns/2/inventory/i1', () =>
                HttpResponse.json({
                    short_id: 'i1',
                    item_name: 'Polvere di luna',
                    description: 'Una polvere argentea raccolta sulle rovine.',
                    notes: null,
                    quantity: 3,
                    category,
                    acquired_at: 1_753_000_000,
                    last_updated: 1_753_000_100,
                    is_artifact: false,
                    artifact_short_id: null,
                    is_cursed: null,
                }),
            ),
            jsonGet('/campaigns/2/inventory/i1/events', pageOf([])),
            http.patch('/api/v1/campaigns/2/inventory/i1/category', async ({ request }) => {
                const body = await request.json() as { category: string };
                category = body.category;
                return HttpResponse.json({
                    short_id: 'i1',
                    item_name: 'Polvere di luna',
                    quantity: 3,
                    category,
                });
            }),
        );

        renderWithProviders(<EntityDetailPage />, {
            route: '/guilds/g1/campaigns/2/inventory/i1',
            path: PATH,
            locale: 'it',
        });

        expect(await screen.findByRole('heading', { name: 'Polvere di luna' })).toBeInTheDocument();
        expect(screen.getByText(/polvere argentea/)).toBeInTheDocument();
        await user.selectOptions(screen.getByRole('combobox', { name: 'Categoria' }), 'MATERIAL');
        await user.click(screen.getByRole('button', { name: 'Salva categoria' }));

        expect(await screen.findByText('Categoria salvata')).toBeInTheDocument();
        expect(category).toBe('MATERIAL');
        expect(screen.getAllByText('Materiale').length).toBeGreaterThan(0);
    });
    it('shows each event\u2019s alignment weight and lets a manager correct it', async () => {
        const user = userEvent.setup();
        let patched: unknown = null;
        server.use(
            jsonGet('/me', { id: 'u1', username: 'manager', globalName: null, avatar: null }),
            jsonGet('/guilds/g1', { id: 'g1', name: 'Guild', icon: null, canManage: true }),
            campaignOverview(2),
            jsonGet('/campaigns/2/npcs/n1', {
                short_id: 'n1',
                name: 'Grimm',
                role: 'Innkeeper',
                status: 'ALIVE',
                description: 'Keeps the only inn on the pass.',
                aliases: null,
                alignment: {
                    moral: { score: 30, label: 'GOOD' },
                    ethical: { score: 0, label: 'NEUTRAL' },
                    cell: 'NEUTRAL_GOOD',
                },
                factions: [],
                last_updated: '2026-07-25',
            }),
            jsonGet('/campaigns/2/npcs/n1/events', pageOf([
                {
                    id: 7,
                    description: 'Hid the refugees in the cellar.',
                    event_type: 'GENERIC',
                    session_id: 's1',
                    timestamp: 1_753_000_000_000,
                    is_manual: 0,
                    moral_weight: 3,
                    ethical_weight: -2,
                },
            ])),
            http.patch('/api/v1/campaigns/2/npcs/n1/events/7', async ({ request }) => {
                patched = await request.json();
                return new HttpResponse(null, { status: 204 });
            }),
        );

        renderWithProviders(<EntityDetailPage />, {
            route: '/guilds/g1/campaigns/2/npcs/n1',
            path: PATH,
        });

        // The weight that produces the alignment bar is now visible on the row.
        expect(await screen.findByText('Hid the refugees in the cellar.')).toBeInTheDocument();
        expect(screen.getByTitle('Moral: +3')).toBeInTheDocument();
        expect(screen.getByTitle('Ethical: -2')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Edit event' }));
        const moral = await screen.findByRole('spinbutton', { name: 'Moral weight' });
        await user.clear(moral);
        await user.type(moral, '5');
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(patched).not.toBeNull());
        expect(patched).toMatchObject({ moral_weight: 5, ethical_weight: -2 });
    });

    it('loads the bard memory on demand and deletes a fragment after confirmation', async () => {
        const user = userEvent.setup();
        let deleted: number | null = null;
        server.use(
            jsonGet('/me', { id: 'u1', username: 'manager', globalName: null, avatar: null }),
            jsonGet('/guilds/g1', { id: 'g1', name: 'Guild', icon: null, canManage: true }),
            campaignOverview(2),
            jsonGet('/campaigns/2/npcs/n1', {
                short_id: 'n1',
                name: 'Grimm',
                role: null,
                status: 'ALIVE',
                description: null,
                aliases: null,
                alignment: {
                    moral: { score: 0, label: 'NEUTRAL' },
                    ethical: { score: 0, label: 'NEUTRAL' },
                    cell: 'NEUTRAL_NEUTRAL',
                },
                factions: [],
                last_updated: null,
            }),
            jsonGet('/campaigns/2/npcs/n1/events', pageOf([])),
            jsonGet('/campaigns/2/npcs/n1/fragments', pageOf([
                {
                    id: 41,
                    session_id: 's3',
                    header: 'The night at the pass',
                    content: 'Grimm refused to open the door to the soldiers.',
                    created_at: 1_753_000_000_000,
                    macro_location: null,
                    micro_location: null,
                    is_entity_snapshot: false,
                },
            ])),
            http.delete('/api/v1/campaigns/2/npcs/n1/fragments/41', () => {
                deleted = 41;
                return new HttpResponse(null, { status: 204 });
            }),
        );

        renderWithProviders(<EntityDetailPage />, {
            route: '/guilds/g1/campaigns/2/npcs/n1',
            path: PATH,
        });

        // The panel starts closed: these are long texts of no use to someone
        // who is only looking at the card.
        const toggle = await screen.findByRole('button', { name: 'Show memory' });
        expect(screen.queryByText(/refused to open the door/)).not.toBeInTheDocument();

        await user.click(toggle);
        expect(await screen.findByText(/refused to open the door/)).toBeInTheDocument();
        expect(screen.getByText('Session memory')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Delete fragment' }));
        expect(await screen.findByText(/once deleted it is not regenerated/)).toBeInTheDocument();
        const confirm = screen.getByRole('dialog', { name: 'Delete fragment' });
        await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

        await waitFor(() => expect(deleted).toBe(41));
    });
    it('gives a table player the write controls even without Discord permissions', async () => {
        server.use(
            jsonGet('/me', { id: 'u1', username: 'player', globalName: null, avatar: null }),
            // No permission on the guild: this used to be enough to hide everything.
            jsonGet('/guilds/g1', { id: 'g1', name: 'Guild', icon: null, canManage: false }),
            campaignOverview(2, { myRole: 'PLAYER', canWrite: true, canManageMembers: false }),
            jsonGet('/campaigns/2/npcs/n1', {
                short_id: 'n1',
                name: 'Grimm',
                role: null,
                status: 'ALIVE',
                description: null,
                aliases: null,
                alignment: {
                    moral: { score: 0, label: 'NEUTRAL' },
                    ethical: { score: 0, label: 'NEUTRAL' },
                    cell: 'NEUTRAL_NEUTRAL',
                },
                factions: [],
                last_updated: null,
            }),
            jsonGet('/campaigns/2/npcs/n1/events', pageOf([])),
        );

        renderWithProviders(<EntityDetailPage />, {
            route: '/guilds/g1/campaigns/2/npcs/n1',
            path: PATH,
        });

        expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    });

    it('hides every write control from someone who is not at the table', async () => {
        server.use(
            jsonGet('/me', { id: 'u1', username: 'onlooker', globalName: null, avatar: null }),
            jsonGet('/guilds/g1', { id: 'g1', name: 'Guild', icon: null, canManage: false }),
            campaignOverview(2, { myRole: null, canWrite: false, canManageMembers: false }),
            jsonGet('/campaigns/2/npcs/n1', {
                short_id: 'n1',
                name: 'Grimm',
                role: null,
                status: 'ALIVE',
                description: null,
                aliases: null,
                alignment: {
                    moral: { score: 0, label: 'NEUTRAL' },
                    ethical: { score: 0, label: 'NEUTRAL' },
                    cell: 'NEUTRAL_NEUTRAL',
                },
                factions: [],
                last_updated: null,
            }),
            jsonGet('/campaigns/2/npcs/n1/events', pageOf([
                {
                    id: 7,
                    description: 'Un evento qualsiasi.',
                    event_type: 'GENERIC',
                    session_id: null,
                    timestamp: 1_753_000_000_000,
                    is_manual: 0,
                    moral_weight: 0,
                    ethical_weight: 0,
                },
            ])),
        );

        renderWithProviders(<EntityDetailPage />, {
            route: '/guilds/g1/campaigns/2/npcs/n1',
            path: PATH,
        });

        expect(await screen.findByRole('heading', { name: 'Grimm', level: 1 })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Edit event' })).not.toBeInTheDocument();
    });
});
