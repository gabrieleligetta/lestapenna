import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiJobBell } from './AiJobBell';
import { AiJobDock } from './AiJobDock';
import { renderWithProviders } from '../test/renderWithProviders';
import { HttpResponse, http, server } from '../test/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function job(overrides: Record<string, unknown> = {}) {
    return {
        id: 'job-1',
        campaign_id: 7,
        guild_id: 'g1',
        kind: 'image',
        target_type: 'npc',
        target_key: 'astr1',
        target_label: 'Astrid Foe',
        requested_by: 'me',
        status: 'running',
        error_kind: null,
        error_message: null,
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        cost_usd: null,
        cost_eur: null,
        pricing_available: false,
        charged: false,
        seen_at: null,
        created_at: Date.now(),
        finished_at: null,
        expires_at: null,
        result: null,
        prompt: null,
        ...overrides,
    };
}

function serve(items: Array<ReturnType<typeof job>>, counts: { unseen?: number; active?: number } = {}) {
    server.use(http.get('/api/v1/me/ai-jobs', () => HttpResponse.json({
        items,
        unseen_count: counts.unseen ?? 0,
        active_count: counts.active ?? items.filter(i => i.status === 'running').length,
    })));
}

/**
 * The card in the corner.
 *
 * Its whole reason to exist is that the panel which starts a portrait lives in a
 * dialog people close. So the tests that matter are: it shows work in flight, it
 * changes when the work is ready, and the ready state leads somewhere a decision
 * can actually be taken.
 */
describe('AiJobDock', () => {
    it('shows nothing when nothing is happening', async () => {
        serve([]);
        const { container } = renderWithProviders(<AiJobDock />);

        // No empty state and no placeholder: a corner card with nothing to say
        // should not be on screen at all.
        await waitFor(() => expect(container.querySelector('.ai-job-dock')).toBeNull());
    });

    it('reports work in flight, and cannot be dismissed while it runs', async () => {
        serve([job()]);
        renderWithProviders(<AiJobDock />);

        expect(await screen.findByText('Astrid Foe')).toBeInTheDocument();
        expect(screen.getByText(/Working/)).toBeInTheDocument();
        // Dismissing something still running would hide the only thing telling
        // the person their money is being spent right now.
        expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    });

    it('leads to the sheet once there is something to accept', async () => {
        serve([job({ status: 'awaiting_review', finished_at: Date.now() })], { active: 0 });
        renderWithProviders(<AiJobDock />);

        const link = await screen.findByRole('link', { name: /Astrid Foe/ });
        expect(link).toHaveAttribute('href', '/guilds/g1/campaigns/7/npcs/astr1');
        expect(screen.getByText(/accept or discard/)).toBeInTheDocument();
    });

    it('says out loud when a restart may have cost something', async () => {
        serve([job({ status: 'failed', error_kind: 'interrupted', finished_at: Date.now() })], { active: 0 });
        renderWithProviders(<AiJobDock />);

        expect(await screen.findByText(/may already have been charged/)).toBeInTheDocument();
    });
});

describe('AiJobBell', () => {
    it('counts only what has finished and not been looked at', async () => {
        serve([job({ status: 'succeeded', finished_at: Date.now() })], { unseen: 1, active: 0 });
        renderWithProviders(<AiJobBell />);

        expect(await screen.findByText('1')).toBeInTheDocument();
    });

    it('marks the outcomes read when opened, and links each one to its sheet', async () => {
        const user = userEvent.setup();
        let seen = 0;
        serve([job({ status: 'awaiting_review', finished_at: Date.now() })], { unseen: 1, active: 0 });
        server.use(http.post('/api/v1/me/ai-jobs/seen', () => {
            seen += 1;
            return new HttpResponse(null, { status: 204 });
        }));

        renderWithProviders(<AiJobBell />);
        await user.click(await screen.findByRole('button', { name: /AI work/ }));

        const link = await screen.findByRole('link', { name: /Astrid Foe/ });
        expect(link).toHaveAttribute('href', '/guilds/g1/campaigns/7/npcs/astr1');
        expect(seen).toBe(1);
    });
});
