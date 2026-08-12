import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BardChatPage } from './BardChatPage';
import { renderWithProviders } from '../test/renderWithProviders';
import { campaignOverview, http, HttpResponse, jsonGet, pageOf, server } from '../test/server';
import type { AskConversation, AskEstimate, AskMessage } from '../api/types';

const ROUTE = '/guilds/g1/campaigns/1/bard';
const PATH = '/guilds/:guildId/campaigns/:campaignId/bard';

function estimate(overrides: Partial<AskEstimate> = {}): AskEstimate {
    return {
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
        ...overrides,
    };
}

function conversation(overrides: Partial<AskConversation> = {}): AskConversation {
    return {
        id: 7,
        title: 'Who is Helena?',
        shared: false,
        owned: true,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        message_count: 0,
        ...overrides,
    };
}

function message(overrides: Partial<AskMessage> = {}): AskMessage {
    return {
        id: 1,
        role: 'assistant',
        content: 'Helena lives in Neverwinter.',
        created_at: 1_700_000_000_000,
        cost_usd: 0.0028,
        cost_eur: 0.0025,
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
        ...overrides,
    };
}

function baseHandlers(options: {
    estimate?: AskEstimate;
    conversations?: AskConversation[];
    messages?: AskMessage[];
} = {}) {
    return [
        campaignOverview(1),
        jsonGet('/campaigns/1/ask/estimate', options.estimate ?? estimate()),
        jsonGet('/campaigns/1/ask/conversations', pageOf(options.conversations ?? [])),
        jsonGet('/campaigns/1/ask/conversations/7', {
            ...conversation(),
            messages: options.messages ?? [],
        }),
    ];
}

/**
 * The page's central requirement: the cost of the action is readable BEFORE
 * the question leaves for the model, and an impossible send is explained
 * rather than failing with a 402.
 */
describe('BardChatPage', () => {
    beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
    afterEach(() => server.resetHandlers());
    afterAll(() => server.close());

    it('dichiara su quale account provider dell’utente andrà la spesa', async () => {
        server.use(...baseHandlers());
        renderWithProviders(<BardChatPage />, { route: ROUTE, path: PATH });

        // BYOK: not a price of ours, but the user's provider and model.
        expect(await screen.findByText(/gemini/)).toBeInTheDocument();
        expect(screen.getByText(/gemini-3-flash-preview/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Ask' })).toBeInTheDocument();
    });

    it('invia la domanda e mostra la risposta con il costo reale sostenuto', async () => {
        const user = userEvent.setup();
        let asked: string | null = null;
        // The thread starts empty and only fills after the question: otherwise
        // the assertion on the answer would already be true before sending.
        let messages: AskMessage[] = [];
        server.use(
            campaignOverview(1),
            jsonGet('/campaigns/1/ask/estimate', estimate()),
            jsonGet('/campaigns/1/ask/conversations', pageOf([conversation()])),
            http.get('/api/v1/campaigns/1/ask/conversations/7', () => HttpResponse.json({
                ...conversation({ message_count: messages.length }),
                messages,
            })),
            http.post('/api/v1/campaigns/1/ask/conversations/7/messages', async ({ request }) => {
                asked = ((await request.json()) as { question: string }).question;
                messages = [
                    message({ id: 1, role: 'user', content: 'Where is Helena?', cost_usd: null, cost_eur: null, model: null }),
                    message({ id: 2 }),
                ];
                return HttpResponse.json({
                    conversation: { ...conversation(), message_count: 2 },
                    message: message({ id: 2 }),
                });
            }),
        );
        renderWithProviders(<BardChatPage />, { route: ROUTE, path: PATH });

        const box = await screen.findByLabelText('Ask the Bard…');
        await user.type(box, 'Where is Helena?');
        await user.click(screen.getByRole('button', { name: 'Ask' }));

        await waitFor(() => expect(asked).toBe('Where is Helena?'));
        expect(await screen.findByText('Helena lives in Neverwinter.')).toBeInTheDocument();
        // The final figure is the real spend on the user's account, not a credit.
        expect(await screen.findByText(/spent on your provider account/)).toBeInTheDocument();
    });

    it('una conversazione condivisa da altri è in sola lettura', async () => {
        server.use(
            campaignOverview(1),
            jsonGet('/campaigns/1/ask/estimate', estimate()),
            jsonGet('/campaigns/1/ask/conversations', pageOf([
                conversation({ owned: false, shared: true, title: 'The Helena case' }),
            ])),
            jsonGet('/campaigns/1/ask/conversations/7', {
                ...conversation({ owned: false, shared: true }),
                messages: [message()],
            }),
        );
        renderWithProviders(<BardChatPage />, { route: ROUTE, path: PATH });

        expect(await screen.findByText(/Shared conversations are read-only/)).toBeInTheDocument();
        expect(screen.queryByLabelText('Ask the Bard…')).not.toBeInTheDocument();
        // No editing action on somebody else's conversation.
        expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    });

    it('permette di rinominare la propria conversazione', async () => {
        const user = userEvent.setup();
        let renamed: string | null = null;
        server.use(
            ...baseHandlers({ conversations: [conversation()] }),
            http.patch('/api/v1/campaigns/1/ask/conversations/7', async ({ request }) => {
                renamed = ((await request.json()) as { title: string }).title;
                return new HttpResponse(null, { status: 204 });
            }),
        );
        renderWithProviders(<BardChatPage />, { route: ROUTE, path: PATH });

        await user.click(await screen.findByRole('button', { name: 'Rename' }));
        const input = screen.getByLabelText('Conversation title');
        await user.clear(input);
        await user.type(input, 'The Helena case');
        await user.click(screen.getByRole('button', { name: 'Save title' }));

        await waitFor(() => expect(renamed).toBe('The Helena case'));
    });
});
