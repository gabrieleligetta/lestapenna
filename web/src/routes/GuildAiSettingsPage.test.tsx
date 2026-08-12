import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GuildAiSettingsPage } from './GuildAiSettingsPage';
import { renderWithProviders } from '../test/renderWithProviders';
import { http, HttpResponse, jsonGet, server } from '../test/server';
import type {
    AiModelOption,
    GuildAiSettings,
    ProviderModels,
    RemoteWhisperModels,
    SessionCostEstimate,
    TranscriptionSettings,
    WakeMethod,
} from '../api/types';

const ROUTE = '/guilds/g1/ai';
const PATH = '/guilds/:guildId/ai';

function settings(overrides: Partial<GuildAiSettings> = {}): GuildAiSettings {
    return {
        guild_id: 'g1',
        quality: { provider: 'openai', model: 'gpt-5.6-terra' },
        fast: null,
        image: null,
        effective: [
            { phase: 'analyst', provider: 'openai', model: 'gpt-5.6-terra', tier: 'quality' },
            { phase: 'chat', provider: 'gemini', model: 'gemini-3-flash-preview', tier: 'fast' },
        ],
        credentials: [
            {
                provider: 'openai', secret_key: 'openai.apiKey', configured: true, hint: '4f2a',
                verify_status: 'OK', verify_error: null, last_verified_at: 1, updated_at: 1,
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
        engine: 'remote',
        remote: {
            url: 'http://100.64.0.1:3001',
            model: null,
            auth_token_configured: false,
            shutdown_enabled: false,
            wake: { mac_address: null, method: 'udp', options: {}, configured_secrets: [] },
        },
        cloud: { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
        usable: true,
        reason: null,
        cloud_usd_per_minute: null,
        ...overrides,
    };
}

const ESTIMATE: SessionCostEstimate = {
    audio_minutes: 240,
    per_phase: [
        {
            phase: 'transcription', provider: 'openai', model: 'gpt-4o-mini-transcribe',
            input_tokens: 0, output_tokens: 0, input_per_million: null, output_per_million: null,
            cost_usd: 0.72, pricing_source: 'builtin', resource_intensive: false,
        },
        {
            phase: 'analyst', provider: 'openai', model: 'gpt-5.6-terra',
            input_tokens: 336000, output_tokens: 96000, input_per_million: 5, output_per_million: 15,
            cost_usd: 2.28, pricing_source: 'builtin', resource_intensive: false,
        },
    ],
    total_usd: 3.0,
    total_eur: 2.7,
    pricing_complete: true,
    resource_intensive_phases: [],
    calibrated: false,
};

const WAKE_METHODS: WakeMethod[] = [
    {
        id: 'udp',
        label: 'Magic packet (Wake-on-LAN standard)',
        description: 'Funziona con quasi tutti i router.',
        fields: [
            { name: 'targetHost', kind: 'text', label: 'Broadcast address or host', hint: null, required: true, placeholder: '192.168.1.255', secret: false },
        ],
    },
    {
        id: 'iliadbox',
        label: 'Iliadbox / Freebox router API',
        description: 'Fa emettere il pacchetto al router.',
        fields: [
            { name: 'iliadboxUrl', kind: 'url', label: 'Router address', hint: null, required: true, placeholder: null, secret: false },
            { name: 'password', kind: 'password', label: 'Router admin password', hint: null, required: true, placeholder: null, secret: true },
        ],
    },
];

/** Common handlers: the page also mounts the transcription section. */
function baseHandlers(settingsBody: GuildAiSettings, transcriptionBody = transcription()) {
    return [
        jsonGet('/guilds/g1/ai-settings', settingsBody),
        jsonGet('/guilds/g1/ai-settings/models', MODELS),
        jsonGet('/guilds/g1/ai-settings/transcription', transcriptionBody),
        jsonGet('/guilds/g1/ai-settings/transcription/models', REMOTE_MODELS),
        jsonGet('/guilds/g1/ai-settings/wake-methods', WAKE_METHODS),
        jsonGet('/guilds/g1/ai-settings/session-estimate', ESTIMATE),
        jsonGet('/guilds/g1/ai-settings/pricing', []),
    ];
}

function option(overrides: Partial<AiModelOption> & { id: string }): AiModelOption {
    return {
        label: null,
        recommended: false,
        input_per_million: null,
        output_per_million: null,
        per_minute_usd: null,
        per_image_usd: null,
        context_tokens: null,
        runs_on_your_hardware: false,
        ...overrides,
    };
}

const MODELS: ProviderModels = {
    provider: 'openai',
    quality: [option({
        id: 'gpt-5.6-terra', label: 'Equilibrato', recommended: true,
        input_per_million: 2.5, output_per_million: 15, context_tokens: 1_050_000,
    })],
    fast: [option({
        id: 'gpt-5.4-mini', label: 'Economico', recommended: true,
        input_per_million: 0.75, output_per_million: 4.5,
    })],
    transcription: [option({ id: 'gpt-4o-mini-transcribe', per_minute_usd: 0.003 })],
    image: [],
    refreshed_at: 1_780_000_000_000,
};

const REMOTE_MODELS: RemoteWhisperModels = {
    models: ['large-v3', 'distil-large-v3'],
    current: 'large-v3',
    reason: null,
};

describe('GuildAiSettingsPage', () => {
    beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
    afterEach(() => server.resetHandlers());
    afterAll(() => server.close());

    it('non mostra mai la chiave, solo le ultime cifre', async () => {
        server.use(...baseHandlers(settings()));
        renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

        // The value comes back from no route: of an existing one we only say
        // how it ends, and the input field stays empty.
        expect(await screen.findByText(/4f2a/)).toBeInTheDocument();
        const inputs = screen.getAllByPlaceholderText(/incolla la chiave|paste the key/i);
        inputs.forEach((input) => expect(input).toHaveValue(''));
    });

    it('avvisa che senza chiavi il tavolo non può registrare', async () => {
        server.use(...baseHandlers(settings({ ready: false })));
        renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

        expect(await screen.findByText(/manca una chiave|a key is missing/i)).toBeInTheDocument();
    });

    it('svuota il campo dopo aver salvato una chiave', async () => {
        const user = userEvent.setup();
        let sent: Record<string, unknown> | null = null;
        server.use(
            ...baseHandlers(settings()),
            http.put('/api/v1/guilds/g1/ai-settings/credentials/gemini', async ({ request }) => {
                sent = (await request.json()) as Record<string, unknown>;
                return new HttpResponse(null, { status: 204 });
            }),
        );
        renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

        const inputs = await screen.findAllByPlaceholderText(/incolla la chiave|paste the key/i);
        const geminiInput = inputs[1];
        await user.type(geminiInput, 'AIza-nuova-chiave');
        await user.click(screen.getAllByRole('button', { name: /salva chiave|save key/i })[1]);

        await waitFor(() => expect(sent).toEqual({ api_key: 'AIza-nuova-chiave' }));
        // It does not stay on screen longer than needed.
        await waitFor(() => expect(geminiInput).toHaveValue(''));
    });

    it('spiega il credito esaurito senza mandare a rigenerare la chiave', async () => {
        server.use(...baseHandlers(settings({
            credentials: [{
                provider: 'openai', secret_key: 'openai.apiKey', configured: true, hint: '4f2a',
                verify_status: 'QUOTA_EXHAUSTED', verify_error: null, last_verified_at: 2, updated_at: 1,
            }],
        })));
        renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

        // The key is valid: saying "invalid" would send the user to regenerate it
        // instead of topping up. And we offer the link where the balance can
        // actually be seen, because no provider exposes it via API.
        expect(await screen.findByText(/credito è finito|out of credit/i)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /platform\.openai\.com/ })).toBeInTheDocument();
    });

    it('a chi non amministra il server mostra tutto ma non lascia toccare nulla', async () => {
        server.use(...baseHandlers(settings({ can_manage: false })));
        renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

        expect(await screen.findByText(/gestire questo server|manage this discord server/i)).toBeInTheDocument();
        screen.getAllByPlaceholderText(/incolla la chiave|paste the key/i)
            .forEach((input) => expect(input).toBeDisabled());
    });

    describe('costi', () => {
        it('mostra il preventivo prima della sessione, non dopo', async () => {
            server.use(...baseHandlers(settings()));
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            expect(await screen.findByText(/3\.00/)).toBeInTheDocument();
        });

        it('dichiara che la stima non è calibrata, invece di farla sembrare misurata', async () => {
            server.use(...baseHandlers(settings()));
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            expect(await screen.findByText(/valori generali|general defaults/i)).toBeInTheDocument();
        });

        it('un prezzo ignoto non diventa zero: niente totale', async () => {
            // This is the defect the phase closes — a total lower than the real one
            // would make the session look cheaper than it is.
            server.use(
                jsonGet('/guilds/g1/ai-settings', settings()),
                jsonGet('/guilds/g1/ai-settings/models', MODELS),
                jsonGet('/guilds/g1/ai-settings/transcription', transcription()),
                jsonGet('/guilds/g1/ai-settings/transcription/models', REMOTE_MODELS),
        jsonGet('/guilds/g1/ai-settings/wake-methods', WAKE_METHODS),
                jsonGet('/guilds/g1/ai-settings/pricing', []),
                jsonGet('/guilds/g1/ai-settings/session-estimate', {
                    ...ESTIMATE,
                    total_usd: null,
                    pricing_complete: false,
                    per_phase: [{
                        phase: 'analyst', provider: 'openai', model: 'gpt-mai-visto',
                        input_tokens: 1000, output_tokens: 100,
                        input_per_million: null, output_per_million: null,
                        cost_usd: null, pricing_source: 'unknown', resource_intensive: false,
                    }],
                }),
            );
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            expect(await screen.findByText(/non conosciamo il prezzo|do not know the price/i)).toBeInTheDocument();
            expect(screen.getByText(/prezzo sconosciuto|price unknown/i)).toBeInTheDocument();
        });
    });

    describe('trascrizione', () => {
        it('avvisa quando il tavolo non può trascrivere', async () => {
            server.use(...baseHandlers(settings(), transcription({
                engine: null, usable: false, reason: 'NOT_CONFIGURED',
            })));
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            expect(await screen.findByText(/non può trascrivere|cannot transcribe/i)).toBeInTheDocument();
        });

        it('mostra il prezzo al minuto prima della scelta, non a consuntivo', async () => {
            server.use(...baseHandlers(settings(), transcription({
                engine: 'cloud', cloud_usd_per_minute: 0.003,
            })));
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            // And the estimate for a whole session: 0.003 × 60 × 4 = 0.72.
            expect(await screen.findByText(/0\.72/)).toBeInTheDocument();
        });

        it('disegna i campi che il metodo di accensione dichiara', async () => {
            // The page knows nothing about the router: if the list of fields comes from
            // the server, adding a method does not touch it.
            server.use(...baseHandlers(settings(), transcription({
                remote: {
                    url: 'http://pc:3001',
                    model: null,
                    auth_token_configured: false,
                    shutdown_enabled: false,
                    wake: { mac_address: 'AA:BB:CC:DD:EE:FF', method: 'iliadbox', options: {}, configured_secrets: [] },
                },
            })));
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            expect(await screen.findByText('Router address')).toBeInTheDocument();
            expect(screen.getByText('Router admin password')).toBeInTheDocument();
        });

        it('accendere è un pulsante a sé, e senza MAC non si può premere', async () => {
            // A boot takes minutes: hiding it inside the test would make a
            // computer that is merely starting up look broken.
            server.use(...baseHandlers(settings(), transcription()));
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            expect(await screen.findByRole('button', { name: /prova la connessione|test connection/i })).toBeEnabled();
            expect(screen.getByRole('button', { name: /accendi|turn the machine on/i })).toBeDisabled();
        });
    });
});
