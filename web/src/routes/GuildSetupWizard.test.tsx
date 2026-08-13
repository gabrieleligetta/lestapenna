import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GuildSetupWizard } from './GuildSetupWizard';
import { renderWithProviders } from '../test/renderWithProviders';
import { http, HttpResponse, jsonGet, server } from '../test/server';
import type { GuildAiSettings, TranscriptionSettings } from '../api/types';

const ROUTE = '/guilds/g1/setup';
const PATH = '/guilds/:guildId/setup';

function settings(overrides: Partial<GuildAiSettings> = {}): GuildAiSettings {
    return {
        guild_id: 'g1',
        quality: null,
        fast: null,
        image: null,
        effective: [],
        credentials: [
            {
                provider: 'openai', secret_key: 'openai.apiKey', configured: false, hint: null,
                verify_status: null, verify_error: null, last_verified_at: null, updated_at: null,
            },
            {
                provider: 'gemini', secret_key: 'gemini.apiKey', configured: false, hint: null,
                verify_status: null, verify_error: null, last_verified_at: null, updated_at: null,
            },
        ],
        ready: false,
        missing_providers: ['gemini'],
        can_manage: true,
        ...overrides,
    };
}

function transcription(overrides: Partial<TranscriptionSettings> = {}): TranscriptionSettings {
    return {
        engine: null,
        remote: {
            url: null,
            model: null,
            auth_token_configured: false,
            shutdown_token_configured: false,
            shutdown_enabled: false,
            wake: { mac_address: null, method: 'udp', options: {}, configured_secrets: [] },
        },
        cloud: { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
        usable: false,
        reason: 'NOT_CONFIGURED',
        cloud_usd_per_minute: null,
        ...overrides,
    };
}

function handlers(settingsBody = settings(), campaigns: unknown[] = []) {
    return [
        jsonGet('/guilds/g1/ai-settings', settingsBody),
        jsonGet('/guilds/g1/ai-settings/models', {
            provider: 'gemini', quality: [], fast: [], transcription: [], image: [], refreshed_at: null,
        }),
        jsonGet('/guilds/g1/ai-settings/transcription', transcription()),
        jsonGet('/guilds/g1/ai-settings/transcription/models', { models: [], current: null, reason: null }),
        jsonGet('/guilds/g1/ai-settings/transcription/status', {
            status: 'NOT_CONFIGURED', detail: null, checked_at: 1, health: null,
        }),
        jsonGet('/guilds/g1/ai-settings/wake-methods', []),
        jsonGet('/guilds/g1/campaigns', campaigns),
    ];
}

describe('GuildSetupWizard', () => {
    beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
    afterEach(() => server.resetHandlers());
    afterAll(() => server.close());

    it('opens on the key, because nothing else works without one', async () => {
        server.use(...handlers());
        renderWithProviders(<GuildSetupWizard />, { route: ROUTE, path: PATH });

        expect(await screen.findByRole('heading', { level: 2 })).toHaveTextContent(
            /una chiave del provider|a provider key/i,
        );
        // First step: there is nothing behind it to go back to.
        expect(screen.getByRole('button', { name: /^indietro$|^back$/i })).toBeDisabled();
    });

    it('saves and verifies in one press, then clears the field', async () => {
        // Someone pasting a key for the first time cannot tell a typo from a
        // provider being down, and both answers come from the same round trip.
        const user = userEvent.setup();
        let stored: Record<string, unknown> | null = null;
        server.use(
            ...handlers(),
            http.put('/api/v1/guilds/g1/ai-settings/credentials/gemini', async ({ request }) => {
                stored = (await request.json()) as Record<string, unknown>;
                return new HttpResponse(null, { status: 204 });
            }),
            http.post('/api/v1/guilds/g1/ai-settings/credentials/gemini/test', () =>
                HttpResponse.json({ provider: 'gemini', status: 'OK', detail: null, model: 'gemini-3.1-flash-lite' })),
        );
        renderWithProviders(<GuildSetupWizard />, { route: ROUTE, path: PATH });

        const field = await screen.findByPlaceholderText(/incolla la chiave|paste the key/i);
        await user.type(field, 'AIza-una-chiave');
        await user.click(screen.getByRole('button', { name: /salva e verifica|save and verify/i }));

        expect(stored).toEqual({ api_key: 'AIza-una-chiave' });
        expect(await screen.findByText(/ha accettato la chiave|accepted the key/i)).toBeInTheDocument();
        expect(field).toHaveValue('');
    });

    it('asks for no key when the table runs on its own hardware', async () => {
        const user = userEvent.setup();
        server.use(...handlers());
        renderWithProviders(<GuildSetupWizard />, { route: ROUTE, path: PATH });

        await user.click(await screen.findByRole('radio', { name: /solo il mio hardware|only my own hardware/i }));

        // Ollama takes no key: asking for one would be asking for something
        // that does not exist.
        expect(screen.queryByPlaceholderText(/incolla la chiave|paste the key/i)).not.toBeInTheDocument();
    });

    it('walks to the end and names what is left, which is not AI', async () => {
        const user = userEvent.setup();
        server.use(...handlers(settings(), [{ id: 7, name: 'Il Trono', is_active: 1 }]));
        renderWithProviders(<GuildSetupWizard />, { route: ROUTE, path: PATH });

        await screen.findByRole('heading', { level: 2 });
        for (let i = 0; i < 4; i++) {
            await user.click(screen.getByRole('button', { name: /^avanti$|^next$/i }));
        }

        // `$listen` also wants the world configured and a [REC] nickname:
        // neither belongs to this page, so both are named rather than rebuilt.
        expect(screen.getByText(/configura il mondo|configure the world/i)).toBeInTheDocument();
        expect(screen.getByText(/\[REC\]/)).toBeInTheDocument();
    });

    it('skips creating a campaign when the server already has one', async () => {
        const user = userEvent.setup();
        server.use(...handlers(settings(), [{ id: 7, name: 'Il Trono', is_active: 1 }]));
        renderWithProviders(<GuildSetupWizard />, { route: ROUTE, path: PATH });

        await screen.findByRole('heading', { level: 2 });
        for (let i = 0; i < 3; i++) {
            await user.click(screen.getByRole('button', { name: /^avanti$|^next$/i }));
        }

        expect(screen.getByText(/Il Trono/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /crea campagna|create campaign/i })).not.toBeInTheDocument();
    });

    it('tells a viewer who cannot save, once, instead of per control', async () => {
        server.use(...handlers(settings({ can_manage: false })));
        renderWithProviders(<GuildSetupWizard />, { route: ROUTE, path: PATH });

        expect(await screen.findByText(/solo un amministratore|only a server administrator/i)).toBeInTheDocument();
    });
});
