import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LegalGate } from './LegalGate';
import { renderWithProviders } from '../test/renderWithProviders';
import { http, HttpResponse, jsonGet, server } from '../test/server';
import type { LegalStatus } from '../api/types';

function status(overrides: Partial<LegalStatus> = {}): LegalStatus {
    return {
        documents: [
            { document: 'terms', current_version: '2026-08-03', accepted_version: null, accepted_at: null, needs_acceptance: true },
            { document: 'privacy', current_version: '2026-08-03', accepted_version: null, accepted_at: null, needs_acceptance: true },
        ],
        needs_acceptance: true,
        ...overrides,
    };
}

describe('LegalGate', () => {
    beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
    afterEach(() => server.resetHandlers());
    afterAll(() => server.close());

    it('tiene le due caselle separate: si accetta, si prende atto', async () => {
        // This is not pedantry: a privacy notice is not «accepted»: under GDPR
        // it is an information duty, and bundling it with the contract confuses
        // transparency with consent.
        server.use(jsonGet('/me/legal', status()));
        renderWithProviders(<LegalGate />, { route: '/', path: '/' });

        expect(await screen.findByLabelText(/accetto i termini|accept the Terms/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/ho letto l'informativa|read the Privacy Policy/i)).toBeInTheDocument();
    });

    it('non lascia proseguire finché non sono spuntate entrambe', async () => {
        const user = userEvent.setup();
        server.use(jsonGet('/me/legal', status()));
        renderWithProviders(<LegalGate />, { route: '/', path: '/' });

        const submit = await screen.findByRole('button', { name: /continua|continue/i });
        expect(submit).toBeDisabled();

        await user.click(screen.getByLabelText(/accetto i termini|accept the Terms/i));
        expect(submit).toBeDisabled();

        await user.click(screen.getByLabelText(/ho letto l'informativa|read the Privacy Policy/i));
        expect(submit).toBeEnabled();
    });

    it('manda i nomi dei documenti, non le versioni', async () => {
        // The server decides the versions: declaring them from the client would mean
        // being able to claim to have accepted a text you never saw.
        const user = userEvent.setup();
        let sent: Record<string, unknown> | null = null;
        server.use(
            jsonGet('/me/legal', status()),
            http.post('/api/v1/me/legal', async ({ request }) => {
                sent = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json(status({ needs_acceptance: false }));
            }),
        );
        renderWithProviders(<LegalGate />, { route: '/', path: '/' });

        await user.click(await screen.findByLabelText(/accetto i termini|accept the Terms/i));
        await user.click(screen.getByLabelText(/ho letto l'informativa|read the Privacy Policy/i));
        await user.click(screen.getByRole('button', { name: /continua|continue/i }));

        await waitFor(() => expect(sent).toEqual({ documents: ['terms', 'privacy'] }));
    });

    it('avvisa che i documenti sono cambiati, invece di ripresentarsi muto', async () => {
        server.use(jsonGet('/me/legal', status({
            documents: [
                { document: 'terms', current_version: '2026-09-01', accepted_version: '2026-08-03', accepted_at: 1, needs_acceptance: true },
                { document: 'privacy', current_version: '2026-08-03', accepted_version: '2026-08-03', accepted_at: 1, needs_acceptance: false },
            ],
        })));
        renderWithProviders(<LegalGate />, { route: '/', path: '/' });

        expect(await screen.findByText(/sono cambiati|have changed/i)).toBeInTheDocument();
    });

    it('dice subito che le sessioni registrano tutti i presenti', async () => {
        // This is the information that really matters, and it has to come first —
        // not be buried on page three of a document nobody opens.
        server.use(jsonGet('/me/legal', status()));
        renderWithProviders(<LegalGate />, { route: '/', path: '/' });

        expect(await screen.findByText(/viene registrato|is recorded/i)).toBeInTheDocument();
    });

    it('non si mette in mezzo a chi ha già accettato', async () => {
        server.use(jsonGet('/me/legal', status({
            needs_acceptance: false,
            documents: [
                { document: 'terms', current_version: '2026-08-03', accepted_version: '2026-08-03', accepted_at: 1, needs_acceptance: false },
                { document: 'privacy', current_version: '2026-08-03', accepted_version: '2026-08-03', accepted_at: 1, needs_acceptance: false },
            ],
        })));
        renderWithProviders(<LegalGate />, { route: '/', path: '/' });

        await waitFor(() =>
            expect(screen.queryByRole('button', { name: /continua|continue/i })).not.toBeInTheDocument());
    });
});
