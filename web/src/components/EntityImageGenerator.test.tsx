import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntityImageGenerator } from './EntityImageGenerator';
import { renderWithProviders } from '../test/renderWithProviders';
import { HttpResponse, http, server } from '../test/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BASE = '/api/v1/campaigns/7/npc/npc1/image/generate';

beforeEach(() => {
    server.use(
        http.get('/api/v1/campaigns/7/npc/npc1/profile', () => HttpResponse.json({
            kind: 'person',
            fields: ['hair.colour'],
            manual_fields: [],
            appearance: { hair: { colour: 'white' } },
            appearance_text: 'white hair',
            personality: null,
            personality_text: null,
            evidence: [],
            confidence: 'HIGH',
            is_manual: false,
            provider: 'gemini',
            model: 'gemini-3-flash-preview',
            generated_at: 1,
            stale_since_session_id: null,
        })),
        http.get(`${BASE}/references`, () => HttpResponse.json([])),
        http.get(`${BASE}/pending`, () => HttpResponse.json(null)),
    );
});

const ESTIMATE = {
    mode: 'auto',
    provider: 'gemini',
    model: 'imagen-4.0-generate-001',
    text_provider: 'gemini',
    text_model: 'gemini-3-flash-preview',
    billable: true,
    pricing_available: true,
    estimated_cost_usd: 0.0405,
    estimated_cost_eur: 0.037,
    reference_count: 0,
    reference_input_cost_included: true,
    exchange_rate: { source: 'ECB', usd_per_eur: 1.1, rate_date: '2026-08-10', fetched_at: 1 },
};

const ACCEPTED = { job_id: 'job-1', status: 'queued' };

/** The register's view of a finished generation, waiting for a decision. */
function job(overrides: Record<string, unknown> = {}) {
    return {
        id: 'job-1',
        campaign_id: 7,
        guild_id: 'g1',
        kind: 'image',
        target_type: 'npc',
        target_key: 'npc1',
        target_label: 'Astrid Foe',
        requested_by: 'me',
        status: 'awaiting_review',
        error_kind: null,
        error_message: null,
        provider: 'gemini',
        model: 'imagen-4.0-generate-001',
        cost_usd: 0.04,
        cost_eur: 0.036,
        pricing_available: true,
        charged: true,
        seen_at: null,
        created_at: Date.now(),
        finished_at: Date.now(),
        expires_at: Date.now() + 600_000,
        result: { width: 768, height: 1024 },
        prompt: null,
        ...overrides,
    };
}

/** Handlers for the two routes the panel follows a job through. */
function jobRoutes(state: Record<string, unknown> = {}) {
    return [
        http.get(`${BASE}/pending`, () => HttpResponse.json(null)),
        http.get('/api/v1/campaigns/7/ai-jobs/job-1', () => HttpResponse.json(job(state))),
    ];
}

function render(props: Partial<Parameters<typeof EntityImageGenerator>[0]> = {}) {
    return renderWithProviders(
        <EntityImageGenerator
            campaignId="7"
            entityType="npc"
            entityId="npc1"
            image={null}
            onGenerated={() => {}}
            {...props}
        />,
    );
}

/**
 * Asking the AI for a picture.
 *
 * Almost everything here is about the money: it is the most expensive action in
 * the product, so the tests that matter are the ones proving nobody can spend
 * without seeing the price, and that an unknown rate is never dressed up as free.
 */
describe('EntityImageGenerator', () => {
    it('preselects contextual references and sends several tags plus one instruction', async () => {
        const user = userEvent.setup();
        let quoted: any;
        server.use(
            http.get(`${BASE}/references`, () => HttpResponse.json([{
                id: 'reference:style',
                scope: 'campaign',
                imageUrl: '/style.webp',
                label: 'Campaign style',
                roles: ['style'],
                instruction: null,
                auto_selected: true,
            }, {
                id: 'media:m1',
                scope: 'entity',
                imageUrl: '/reference.webp',
                label: 'Astrid source',
                roles: ['subject_identity'],
                instruction: null,
                auto_selected: true,
            }])),
            http.post(`${BASE}/estimate`, async ({ request }) => {
                quoted = await request.json();
                return HttpResponse.json({ ...ESTIMATE, reference_count: 2 });
            }),
        );

        render();
        const astridToggle = await screen.findByRole('checkbox', { name: /Astrid source/ });
        expect(astridToggle).toBeChecked();
        const astrid = within(astridToggle.closest('li')!);
        expect(astrid.getByRole('checkbox', { name: 'Subject identity' })).toBeChecked();
        await user.click(astrid.getByRole('checkbox', { name: 'Hair' }));
        await user.type(
            astrid.getByPlaceholderText(/keep the clothing design/i),
            'Keep the same face and make the robe white.',
        );
        await user.click(screen.getByRole('button', { name: /^Generate$/ }));

        await waitFor(() => expect(quoted).toBeTruthy());
        expect(quoted.references).toEqual([
            {
                id: 'media:m1',
                roles: ['subject_identity', 'hair'],
                instruction: 'Keep the same face and make the robe white.',
                priority: 1,
            },
            {
                id: 'reference:style',
                roles: ['style'],
                instruction: null,
                priority: 2,
            },
        ]);
    });

    it('shows the cost and waits for a confirmation before spending anything', async () => {
        const user = userEvent.setup();
        const generate = vi.fn();
        server.use(
            http.post(`${BASE}/estimate`, () => HttpResponse.json(ESTIMATE)),
            http.post(BASE, () => {
                generate();
                return HttpResponse.json(ACCEPTED, { status: 202 });
            }),
            ...jobRoutes(),
        );

        render();
        await user.click(screen.getByRole('button', { name: /Generate/ }));

        // The dialog is up and nothing has been spent yet.
        expect(await screen.findByRole('dialog')).toBeInTheDocument();
        expect(generate).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: 'Confirm and use AI' }));
        await waitFor(() => expect(generate).toHaveBeenCalled());
    });

    it('spends nothing when the confirmation is dismissed', async () => {
        const user = userEvent.setup();
        const generate = vi.fn();
        server.use(
            http.post(`${BASE}/estimate`, () => HttpResponse.json(ESTIMATE)),
            http.post(BASE, () => {
                generate();
                return HttpResponse.json(ACCEPTED, { status: 202 });
            }),
            ...jobRoutes(),
        );

        render();
        await user.click(screen.getByRole('button', { name: /Generate/ }));
        await user.click(await screen.findByRole('button', { name: 'Cancel' }));

        expect(generate).not.toHaveBeenCalled();
    });

    it('previews the picture without applying it, and applies it only on request', async () => {
        const user = userEvent.setup();
        const commit = vi.fn();
        server.use(
            http.post(`${BASE}/estimate`, () => HttpResponse.json(ESTIMATE)),
            http.post(BASE, () => HttpResponse.json(ACCEPTED, { status: 202 })),
            ...jobRoutes(),
            http.post(`${BASE}/job-1/commit`, () => {
                commit();
                return HttpResponse.json({ id: 'm1' });
            }),
        );

        render();
        await user.click(screen.getByRole('button', { name: /Generate/ }));
        await user.click(await screen.findByRole('button', { name: 'Confirm and use AI' }));

        const preview = await screen.findByRole('img', { name: 'Preview' });
        // Addressed rather than inlined: the bytes are in the bucket from the
        // moment they were paid for, so there is something to point at.
        expect(preview).toHaveAttribute('src', `${BASE}/job-1/preview`);
        // The picture is being offered, not yet put on the sheet.
        expect(commit).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: 'Enlarge image' }));
        expect(screen.getByRole('dialog').querySelector('img'))
            .toHaveAttribute('src', `${BASE}/job-1/preview`);
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Keep this image' }));
        await waitFor(() => expect(commit).toHaveBeenCalled());
    });

    it('picks up a generation already under way, so closing this panel loses nothing', async () => {
        // The case the whole register exists for: the dialog was closed, the
        // page navigated away from, or the server restarted mid-draw.
        const generate = vi.fn();
        server.use(
            http.get(`${BASE}/pending`, () => HttpResponse.json(job())),
            http.get('/api/v1/campaigns/7/ai-jobs/job-1', () => HttpResponse.json(job())),
            http.post(BASE, () => {
                generate();
                return HttpResponse.json(ACCEPTED, { status: 202 });
            }),
        );

        render();

        expect(await screen.findByRole('img', { name: 'Preview' })).toBeInTheDocument();
        // Adopted, not restarted: nobody pays twice for having closed a dialog.
        expect(generate).not.toHaveBeenCalled();
    });

    it('says so while it is drawing, and that leaving is safe', async () => {
        const user = userEvent.setup();
        server.use(
            http.post(`${BASE}/estimate`, () => HttpResponse.json(ESTIMATE)),
            http.post(BASE, () => HttpResponse.json(ACCEPTED, { status: 202 })),
            ...jobRoutes({ status: 'running', finished_at: null }),
        );

        render();
        await user.click(screen.getByRole('button', { name: /Generate/ }));
        await user.click(await screen.findByRole('button', { name: 'Confirm and use AI' }));

        expect(await screen.findByText(/You can close this and carry on/)).toBeInTheDocument();
    });

    it('says the price is unknown rather than implying the picture was free', async () => {
        const user = userEvent.setup();
        server.use(
            http.post(`${BASE}/estimate`, () => HttpResponse.json(ESTIMATE)),
            http.post(BASE, () => HttpResponse.json(ACCEPTED, { status: 202 })),
            ...jobRoutes({ cost_usd: null, cost_eur: null, pricing_available: false }),
        );

        render();
        await user.click(screen.getByRole('button', { name: /Generate/ }));
        await user.click(await screen.findByRole('button', { name: 'Confirm and use AI' }));

        expect(await screen.findByText(/It is not free/)).toBeInTheDocument();
    });

    it('will not run a written-description mode with nothing written', async () => {
        const user = userEvent.setup();
        render();

        await user.click(screen.getByRole('radio', { name: /From your description/ }));
        expect(screen.getByRole('button', { name: /Generate/ })).toBeDisabled();

        await user.type(screen.getByRole('textbox'), 'an old woman with a raven');
        expect(screen.getByRole('button', { name: /Generate/ })).toBeEnabled();
    });

    it('reopens on a generated picture with the same request, ready to be edited', async () => {
        // The stored words are a starting point, not a locked value: repeating
        // the request and amending it are the same one-click path.
        render({
            image: {
                id: 'm1',
                thumbnailUrl: '/t',
                displayUrl: '/d',
                width: 8,
                height: 10,
                altText: null,
                source: 'ai',
                generationMode: 'mixed',
                generationPrompt: 'make him much older',
                updatedAt: 1,
            },
        });

        expect(screen.getByRole('radio', { name: /Both/ })).toBeChecked();
        expect(screen.getByRole('textbox')).toHaveValue('make him much older');
        await waitFor(() => expect(screen.getByRole('button', { name: /Generate again/ })).toBeEnabled());
    });

    it('reports a refusal as something to change, not as a broken key', async () => {
        const user = userEvent.setup();
        server.use(
            http.post(`${BASE}/estimate`, () => HttpResponse.json(ESTIMATE)),
            http.post(BASE, () => HttpResponse.json(
                { message: 'The image provider refused this prompt: blocked by the safety filter' },
                { status: 400 },
            )),
            ...jobRoutes(),
        );

        render();
        await user.click(screen.getByRole('button', { name: /Generate/ }));
        await user.click(await screen.findByRole('button', { name: 'Confirm and use AI' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(/refused this prompt/);
    });

    it('says an overloaded provider is not a fault of the product', async () => {
        // The reported case: a busy minute at Google reached the table as
        // «internal server error», which is a sentence about this app.
        const user = userEvent.setup();
        server.use(
            http.post(`${BASE}/estimate`, () => HttpResponse.json(ESTIMATE)),
            http.post(BASE, () => HttpResponse.json(
                { message: 'The gemini model did not answer: it is momentarily overloaded' },
                { status: 502 },
            )),
            ...jobRoutes(),
        );

        render();
        await user.click(screen.getByRole('button', { name: /Generate/ }));
        await user.click(await screen.findByRole('button', { name: 'Confirm and use AI' }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(/busy or unreachable/);
        expect(alert).toHaveTextContent(/try again/i);
    });
});
