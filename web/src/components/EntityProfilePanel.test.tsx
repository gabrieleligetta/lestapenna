import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntityProfilePanel } from './EntityProfilePanel';
import { renderWithProviders } from '../test/renderWithProviders';
import { HttpResponse, http, server } from '../test/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const PROFILE_URL = '/api/v1/campaigns/1/npc/astr1/profile';

const DOSSIER = {
    kind: 'person' as const,
    fields: ['hair.colour', 'eyes', 'personality.manner'],
    manual_fields: [] as string[],
    appearance: { hair: { colour: 'white' } },
    appearance_text: 'hair: colour white, style swept back',
    personality: { manner: 'stiff and formal' },
    personality_text: null,
    evidence: [
        {
            trait: 'hair.colour',
            quote: 'ha i capelli bianchi',
            source: 'transcript' as const,
            session_id: '12',
        },
    ],
    confidence: 'HIGH' as const,
    is_manual: false,
    provider: 'gemini',
    model: 'gemini-3-flash-preview',
    generated_at: 1,
    stale_since_session_id: null,
};

function panel() {
    return <EntityProfilePanel campaignId="1" entityType="npc" entityId="astr1" canEdit />;
}

describe('EntityProfilePanel', () => {
    it('says an unanalysed subject is unrecorded instead of showing nothing', async () => {
        server.use(http.get(PROFILE_URL, () => HttpResponse.json({
            ...DOSSIER,
            appearance: null,
            appearance_text: null,
            personality: null,
            evidence: [],
            confidence: null,
        })));

        renderWithProviders(panel());

        expect(await screen.findByText(/nothing recorded yet/i)).toBeInTheDocument();
    });

    it('shows each trait with the words it came from', async () => {
        server.use(http.get(PROFILE_URL, () => HttpResponse.json(DOSSIER)));
        const user = userEvent.setup();

        renderWithProviders(panel());

        expect(await screen.findByText(/colour white/)).toBeInTheDocument();
        expect(screen.getByText('stiff and formal')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: /where this comes from/i }));
        expect(screen.getByText('ha i capelli bianchi')).toBeInTheDocument();
        expect(screen.getByText(/the recording/)).toBeInTheDocument();
    });

    it('does not spend before the estimate has been confirmed', async () => {
        let analysed = false;
        server.use(
            http.get(PROFILE_URL, () => HttpResponse.json({ ...DOSSIER, appearance: null, appearance_text: null, personality: null, evidence: [] })),
            http.get(`${PROFILE_URL}/analyze/estimate`, () => HttpResponse.json({
                provider: 'gemini',
                model: 'gemini-3-flash-preview',
                billable: true,
                pricing_available: true,
                estimated_cost_usd: { min: 0.002, max: 0.01 },
                estimated_cost_eur: { min: 0.002, max: 0.009 },
                exchange_rate: { source: 'ECB', usd_per_eur: 1.1, rate_date: null, fetched_at: null },
            })),
            http.post(`${PROFILE_URL}/analyze`, () => {
                analysed = true;
                return HttpResponse.json({
                    profile: DOSSIER,
                    not_recorded: ['eyes'],
                    kept_fields: [],
                    cost_usd: 0.004,
                    cost_eur: 0.0036,
                    pricing_available: true,
                });
            }),
        );
        const user = userEvent.setup();

        renderWithProviders(panel());
        await user.click(await screen.findByRole('button', { name: /analyse the campaign/i }));

        // The modal is up and nothing has been called yet: this is the whole
        // point of the confirmation on an action that spends somebody's money.
        expect(await screen.findByRole('dialog')).toBeInTheDocument();
        expect(analysed).toBe(false);

        await user.click(screen.getByRole('button', { name: /confirm and use ai/i }));
        await waitFor(() => expect(analysed).toBe(true));
        // And the gaps come back with the result, rather than being quietly dropped.
        expect(await screen.findByText(/eyes/)).toBeInTheDocument();
    });

    it('lets a person fill in a field the analysis left empty, with no model called', async () => {
        let patched: any = null;
        server.use(
            http.get(PROFILE_URL, () => HttpResponse.json(DOSSIER)),
            http.patch(PROFILE_URL, async ({ request }) => {
                patched = await request.json();
                return HttpResponse.json(DOSSIER);
            }),
        );
        const user = userEvent.setup();

        renderWithProviders(panel());
        await user.click(await screen.findByRole('button', { name: /correct it/i }));

        // The whole vocabulary is offered, not only what the AI happened to
        // fill: the empty fields are exactly the ones a person can answer.
        const eyes = screen.getByLabelText(/eyes/i);
        await user.type(eyes, 'amber');
        await user.click(screen.getByRole('button', { name: /^save$/i }));

        await waitFor(() => expect(patched).not.toBeNull());
        // Only what changed: sending every field would claim ownership of the
        // ones the analysis found and the person merely looked at.
        expect(patched).toEqual({ fields: { eyes: 'amber' } });
    });

    it('marks a dossier the campaign has moved past, without redoing it on its own', async () => {
        server.use(http.get(PROFILE_URL, () => HttpResponse.json({
            ...DOSSIER,
            stale_since_session_id: 'session-42',
        })));

        renderWithProviders(panel());

        expect(await screen.findByText(/out of date/i)).toBeInTheDocument();
        expect(screen.getByText(/would spend on your provider account/i)).toBeInTheDocument();
    });
});
