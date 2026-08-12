import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntityListPage } from './EntityListPage';
import { renderWithProviders } from '../test/renderWithProviders';
import { server, jsonGet, pageOf, http, HttpResponse, campaignOverview } from '../test/server';

const ROUTE = '/guilds/g1/campaigns/1/npcs';
const PATH = '/guilds/:guildId/campaigns/:campaignId/:entityType';

const NPC = {
    short_id: 'ab12c',
    name: 'Helena',
    status: 'ALIVE',
    role: 'Innkeeper',
    description: 'A mysterious figure',
    alignment_moral: 'GOOD',
    alignment_ethical: 'LAWFUL',
    moral_score: 72,
    ethical_score: 12,
    last_updated: '2026-07-01',
};

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => server.use(jsonGet('/guilds/g1', { id: 'g1', name: 'G', icon: null, canManage: false })));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('EntityListPage', () => {
    it('renders the rows returned in the page envelope', async () => {
        server.use(jsonGet('/campaigns/1/npcs', pageOf([NPC], 1)));
        renderWithProviders(<EntityListPage />, { route: ROUTE, path: PATH });

        expect(await screen.findByText('Helena')).toBeInTheDocument();
        expect(screen.getByText('Innkeeper')).toBeInTheDocument();
    });

    it('links the micro-location represented by the detail instead of its macro region', async () => {
        server.use(jsonGet('/campaigns/1/locations', pageOf([{
            short_id: 'loc1',
            macro_location: 'Terre Selvagge',
            micro_location: 'Deserto Anomalo',
        }])));
        renderWithProviders(<EntityListPage />, {
            route: '/guilds/g1/campaigns/1/locations',
            path: PATH,
            locale: 'it',
        });

        expect(await screen.findByRole('link', { name: 'Deserto Anomalo' })).toHaveAttribute(
            'href',
            '/guilds/g1/campaigns/1/locations/loc1',
        );
        expect(screen.getByText('Terre Selvagge')).not.toBeInstanceOf(HTMLAnchorElement);
    });

    it('persists the inventory category filter in the URL-backed request', async () => {
        let requestedCategory: string | null = null;
        server.use(
            http.get('/api/v1/campaigns/1/inventory', ({ request }) => {
                requestedCategory = new URL(request.url).searchParams.get('category');
                return HttpResponse.json(pageOf([{
                    short_id: 'inv1',
                    item_name: 'Lama lunare',
                    quantity: 1,
                    category: 'WEAPON',
                    is_artifact: false,
                }]));
            }),
        );
        renderWithProviders(<EntityListPage />, {
            route: '/guilds/g1/campaigns/1/inventory?category=WEAPON',
            path: PATH,
            locale: 'it',
        });

        expect(await screen.findByText('Lama lunare')).toBeInTheDocument();
        expect(requestedCategory).toBe('WEAPON');
        expect(screen.getByRole('combobox', { name: 'Categoria' })).toHaveValue('WEAPON');
        expect(screen.getAllByText('Arma').length).toBeGreaterThan(0);
    });

    it('shows the real range from `total`, not the page length', async () => {
        // 214 rows total, 25 on this page: the old UI could only say "Next is enabled".
        const rows = Array.from({ length: 25 }, (_, i) => ({ ...NPC, short_id: `id${i}`, name: `NPC ${i}` }));
        server.use(jsonGet('/campaigns/1/npcs', pageOf(rows, 214)));
        renderWithProviders(<EntityListPage />, { route: ROUTE, path: PATH });

        expect(await screen.findByText('1-25 of 214')).toBeInTheDocument();
    });

    it('disables Next on the last page even when it is exactly full', async () => {
        // The old rows.length < PAGE_SIZE heuristic got this wrong: a final page of
        // exactly 25 looked like there was more to come.
        const rows = Array.from({ length: 25 }, (_, i) => ({ ...NPC, short_id: `id${i}`, name: `NPC ${i}` }));
        server.use(jsonGet('/campaigns/1/npcs', pageOf(rows, 25)));
        renderWithProviders(<EntityListPage />, { route: ROUTE, path: PATH });

        expect(await screen.findByText('NPC 0')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    });

    it('does not leak plumbing column names as table headers', async () => {
        server.use(jsonGet('/campaigns/1/npcs', pageOf([NPC], 1)));
        renderWithProviders(<EntityListPage />, { route: ROUTE, path: PATH });

        await screen.findByText('Helena');
        for (const leaked of ['rag_sync_needed', 'manual_description', 'campaign_id']) {
            expect(screen.queryByText(leaked)).toBeNull();
        }
    });

    it('renders the empty state when the campaign has no rows', async () => {
        server.use(jsonGet('/campaigns/1/npcs', pageOf([], 0)));
        renderWithProviders(<EntityListPage />, { route: ROUTE, path: PATH });

        expect(await screen.findByText('Nothing here yet.')).toBeInTheDocument();
    });

    it('surfaces an error state instead of an empty table', async () => {
        server.use(jsonGet('/campaigns/1/npcs', { message: 'boom' }, 500));
        renderWithProviders(<EntityListPage />, { route: ROUTE, path: PATH });

        expect(await screen.findByText('Something went wrong.')).toBeInTheDocument();
    });

    it('translates IN_PROGRESS and presents it as a dedicated status badge', async () => {
        server.use(jsonGet('/campaigns/1/quests', pageOf([{
            short_id: 'q1',
            title: 'Aprire il sigillo',
            status: 'IN_PROGRESS',
        }])));
        renderWithProviders(<EntityListPage />, {
            route: '/guilds/g1/campaigns/1/quests',
            path: PATH,
            locale: 'it',
        });

        await waitFor(() => expect(screen.getAllByText('In corso')).toHaveLength(2));
        expect(screen.queryByText('IN_PROGRESS')).not.toBeInTheDocument();
        expect(
            screen.getAllByText('In corso').some((node) =>
                Boolean(node.closest('.badge-accent')?.querySelector('.badge-icon')),
            ),
        ).toBe(true);
    });

    it('exposes manager quest CRUD and the explicit historical audit', async () => {
        const user = userEvent.setup();
        let createdBody: Record<string, unknown> | null = null;
        let auditCalls = 0;
        server.use(
            jsonGet('/guilds/g1', { id: 'g1', name: 'G', icon: null, canManage: true }),
            campaignOverview(),
            jsonGet('/campaigns/1/quests', pageOf([], 0)),
            jsonGet('/campaigns/1/quests/lifecycle-suggestions', []),
            http.post('/api/v1/campaigns/1/quests', async ({ request }) => {
                createdBody = await request.json() as Record<string, unknown>;
                return HttpResponse.json({
                    short_id: 'qnew1',
                    ...createdBody,
                }, { status: 201 });
            }),
            jsonGet('/campaigns/1/quests/lifecycle-audit/estimate', {
                status: 'READY',
                will_invoke_ai: true,
                billable: true,
                pricing_available: true,
                provider: 'gemini',
                model: 'gemini-3.1-pro-preview',
                session_count: 12,
                open_quest_count: 4,
                pending_suggestion_count: 0,
                estimated_tokens: {
                    input_min: 1000,
                    input_max: 2000,
                    output_min: 300,
                    output_max: 900,
                },
                estimated_cost_usd: { min: 0.01, max: 0.03 },
                estimated_cost_eur: { min: 0.009, max: 0.027 },
                exchange_rate: {
                    source: 'ECB',
                    usd_per_eur: 1.1,
                    rate_date: '2026-07-27',
                    fetched_at: Date.now(),
                },
                cooldown_ends_at: null,
            }),
            http.post('/api/v1/campaigns/1/quests/lifecycle-audit', () => {
                auditCalls += 1;
                // Accepted, not finished: the audit reads every session the
                // table has and reports back through the corner card.
                return HttpResponse.json(
                    { job_id: 'job-1', invoked_ai: true, skipped_reason: null },
                    { status: 202 },
                );
            }),
        );
        renderWithProviders(<EntityListPage />, {
            route: '/guilds/g1/campaigns/1/quests',
            path: PATH,
        });

        // The button and the modal are now the ones shared by every entity.
        await user.click(await screen.findByRole('button', { name: 'New: Quests' }));
        const dialog = screen.getByRole('dialog', { name: 'New: Quests' });
        await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Protect the archive');
        await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Keep the imperial records safe.');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'IN_PROGRESS');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'MINOR');
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(createdBody).not.toBeNull());
        expect(dialog).not.toBeInTheDocument();
        expect(createdBody).toEqual({
            title: 'Protect the archive',
            description: 'Keep the imperial records safe.',
            status: 'IN_PROGRESS',
            type: 'MINOR',
        });

        await user.click(screen.getByRole('button', { name: 'AI cost information' }));
        expect(screen.getByRole('tooltip')).toHaveTextContent('on the provider you configured');
        await user.click(screen.getByRole('button', { name: 'Audit history' }));
        expect(await screen.findByRole('dialog', { name: 'Confirm AI usage' })).toBeInTheDocument();
        expect(screen.getByText('gemini · gemini-3.1-pro-preview')).toBeInTheDocument();
        expect(screen.getByText(/12 sessions · 4 open quests/)).toBeInTheDocument();
        // The modal shows the estimated spend on the user's provider account.
        expect(screen.getByText(/€0.009000 – €0.027000/)).toBeInTheDocument();
        expect(auditCalls).toBe(0);

        await user.click(screen.getByRole('button', { name: 'Confirm and use AI' }));
        // The panel says the work has started and stops there: the outcome and
        // its cost arrive through the register, not by holding this page open.
        expect(await screen.findByText(/Reviewing the quests/)).toBeInTheDocument();
        expect(auditCalls).toBe(1);
    });

    it('refreshes cooldown suggestions without opening a paid confirmation or calling AI', async () => {
        const user = userEvent.setup();
        let auditCalls = 0;
        server.use(
            jsonGet('/guilds/g1', { id: 'g1', name: 'G', icon: null, canManage: true }),
            campaignOverview(),
            jsonGet('/campaigns/1/quests', pageOf([], 0)),
            jsonGet('/campaigns/1/quests/lifecycle-suggestions', []),
            jsonGet('/campaigns/1/quests/lifecycle-audit/estimate', {
                status: 'COOLDOWN',
                will_invoke_ai: false,
                billable: false,
                pricing_available: true,
                provider: 'gemini',
                model: 'gemini-3.1-pro-preview',
                session_count: 12,
                open_quest_count: 4,
                pending_suggestion_count: 0,
                estimated_tokens: null,
                estimated_cost_usd: null,
                estimated_cost_eur: null,
                exchange_rate: {
                    source: 'UNAVAILABLE',
                    usd_per_eur: null,
                    rate_date: null,
                    fetched_at: null,
                },
                cooldown_ends_at: Date.now() + 60_000,
            }),
            http.post('/api/v1/campaigns/1/quests/lifecycle-audit', () => {
                auditCalls += 1;
                return HttpResponse.json({});
            }),
        );
        renderWithProviders(<EntityListPage />, {
            route: '/guilds/g1/campaigns/1/quests',
            path: PATH,
        });

        await user.click(await screen.findByRole('button', { name: 'Audit history' }));
        expect(await screen.findByText(/cooldown period/)).toBeInTheDocument();
        expect(screen.queryByRole('dialog', { name: 'Confirm AI usage' })).not.toBeInTheDocument();
        expect(auditCalls).toBe(0);
    });

    it('does not present the retired encounter count in the bestiary', async () => {
        server.use(jsonGet('/campaigns/1/bestiary', pageOf([{
            short_id: 'beast1',
            name: 'Branco spettrale',
            status: 'ALIVE',
            count: 'molti',
        }])));
        renderWithProviders(<EntityListPage />, {
            route: '/guilds/g1/campaigns/1/bestiary',
            path: PATH,
            locale: 'it',
        });

        expect(await screen.findByText('Branco spettrale')).toBeInTheDocument();
        expect(screen.queryByText('molti')).not.toBeInTheDocument();
        expect(screen.queryByRole('columnheader', { name: 'Numero' })).not.toBeInTheDocument();
    });

    it('turns checkbox selection into the shared merge wizard for managers', async () => {
        const user = userEvent.setup();
        const secondNpc = { ...NPC, short_id: 'xy98z', name: 'Helena la Locandiera' };
        server.use(
            jsonGet('/guilds/g1', { id: 'g1', name: 'G', icon: null, canManage: true }),
            campaignOverview(),
            jsonGet('/campaigns/1/npcs', pageOf([NPC, secondNpc], 2)),
            http.post('/api/v1/campaigns/1/merge/npcs/members', () => HttpResponse.json([
                { short_id: NPC.short_id, name: NPC.name, is_manual: 0, history_count: 2, has_rag: true, description: NPC.description, score: 0, reason: 'manual_selection' },
                { short_id: secondNpc.short_id, name: secondNpc.name, is_manual: 0, history_count: 1, has_rag: false, description: secondNpc.description, score: 0, reason: 'manual_selection' },
            ])),
        );
        renderWithProviders(<EntityListPage />, { route: ROUTE, path: PATH });

        await user.click(await screen.findByRole('checkbox', { name: 'Select Helena' }));
        expect(screen.getByRole('button', { name: 'Merge selected (1)' })).toBeDisabled();

        await user.click(screen.getByRole('checkbox', { name: 'Select Helena la Locandiera' }));
        const mergeButton = screen.getByRole('button', { name: 'Merge selected (2)' });
        expect(mergeButton).toBeEnabled();
        await user.click(mergeButton);

        expect(await screen.findByRole('dialog', { name: 'Merge duplicate entities' })).toBeInTheDocument();
    });

    it('offers the same checkbox merge flow on factions', async () => {
        const user = userEvent.setup();
        server.use(
            jsonGet('/guilds/g1', { id: 'g1', name: 'G', icon: null, canManage: true }),
            campaignOverview(),
            jsonGet('/campaigns/1/factions', pageOf([
                { short_id: 'iron1', name: 'Dame di Ferro', status: 'ACTIVE', is_party: 0, reputation: 'NEUTRAL' },
                { short_id: 'iron2', name: 'Vergini di Ferro', status: 'ACTIVE', is_party: 0, reputation: 'NEUTRAL' },
            ], 2)),
        );
        renderWithProviders(<EntityListPage />, {
            route: '/guilds/g1/campaigns/1/factions',
            path: PATH,
        });

        await user.click(await screen.findByRole('checkbox', { name: 'Select Dame di Ferro' }));
        await user.click(screen.getByRole('checkbox', { name: 'Select Vergini di Ferro' }));

        expect(screen.getByRole('button', { name: 'Merge selected (2)' })).toBeEnabled();
    });

    it('renders world events as an icon timeline instead of a technical table', async () => {
        server.use(jsonGet('/campaigns/1/timeline', pageOf([{
            short_id: 'ev1',
            year: 1492,
            event_type: 'DISCOVERY',
            description: 'The sealed observatory was found.',
            session_id: 's7',
            timestamp: 1_753_000_000,
        }])));
        const { container } = renderWithProviders(<EntityListPage />, {
            route: '/guilds/g1/campaigns/1/timeline',
            path: PATH,
        });

        expect(await screen.findByText('Discovery')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'The sealed observatory was found.' })).toHaveAttribute(
            'href',
            '/guilds/g1/campaigns/1/timeline/ev1',
        );
        expect(container.querySelector('.world-timeline__marker .icon')).toBeInTheDocument();
        expect(container.querySelector('.entity-table')).not.toBeInTheDocument();
    });
});
