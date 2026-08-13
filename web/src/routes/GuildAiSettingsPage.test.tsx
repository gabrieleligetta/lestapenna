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
            shutdown_token_configured: false,
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
        // The checklist reads the campaigns too: with nowhere to record into,
        // a fully configured key is still a table that cannot start.
        jsonGet('/guilds/g1/campaigns', []),
        // A machine that does not answer is the default state of the fixture,
        // as it is of a real one. Individual tests override it.
        jsonGet('/guilds/g1/ai-settings/transcription/status', {
            status: 'UNREACHABLE', detail: null, checked_at: 1, health: null,
        }),
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
                    shutdown_token_configured: false,
                    shutdown_enabled: false,
                    wake: { mac_address: 'AA:BB:CC:DD:EE:FF', method: 'iliadbox', options: {}, configured_secrets: [] },
                },
            })));
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            expect(await screen.findByText('Router address')).toBeInTheDocument();
            expect(screen.getByText('Router admin password')).toBeInTheDocument();
        });

        it('accendere è un pulsante a sé, e senza MAC non si può premere', async () => {
            // A boot takes minutes: hiding it inside the probe would make a
            // computer that is merely starting up look broken.
            server.use(...baseHandlers(settings(), transcription()));
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            expect(await screen.findByRole('button', { name: /ricontrolla|check again/i })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /^accendi$|^turn it on$/i })).toBeDisabled();
        });
    });

    describe('the table\'s own machine', () => {
        it('says whether it is on, and what it is running', async () => {
            // The one fact somebody opens this page for before a session, and
            // the one the probe used to throw away with the response body.
            server.use(jsonGet('/guilds/g1/ai-settings/transcription/status', {
                status: 'OK',
                detail: null,
                checked_at: Date.parse('2026-08-13T12:04:00Z'),
                health: {
                    gpu: true, accelerator: 'RTX 5060 TI (CUDA)', model: 'large-v3',
                    cpu: null, cpu_cores: null, total_memory: null, free_memory: null, uptime_seconds: 4_200,
                },
            }), ...baseHandlers(settings()));
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            expect(await screen.findByText(/^acceso$|^on$/i)).toBeInTheDocument();
            // Accelerator and loaded model on one line: "on" alone does not tell
            // you whether the machine is running the model you chose.
            expect(screen.getByText(/RTX 5060 TI.*large-v3/)).toBeInTheDocument();
            expect(screen.getByText(/1h 10m/)).toBeInTheDocument();
        });

        it('renders a switched-off machine as a state, not a failure', async () => {
            server.use(jsonGet('/guilds/g1/ai-settings/transcription/status', {
                status: 'UNREACHABLE', detail: 'connect ECONNREFUSED', checked_at: 1, health: null,
            }), ...baseHandlers(settings()));
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            // Being off is the normal state of somebody's home computer.
            const badge = await screen.findByText(/^spento$|^off$/i);
            expect(badge).toHaveClass('badge-neutral');
        });

        it('will not shut down a machine with no shutdown token stored', async () => {
            server.use(
                jsonGet('/guilds/g1/ai-settings/transcription/status', {
                    status: 'OK', detail: null, checked_at: 1, health: null,
                }),
                ...baseHandlers(settings(), transcription({
                    remote: {
                        url: 'http://pc:3001',
                        model: null,
                        auth_token_configured: true,
                        shutdown_token_configured: false,
                        shutdown_enabled: true,
                        wake: { mac_address: 'AA:BB:CC:DD:EE:FF', method: 'udp', options: {}, configured_secrets: [] },
                    },
                })),
            );
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            expect(await screen.findByRole('button', { name: /^spegni$|^shut it down$/i })).toBeDisabled();
            // And it says which field fixes it, next to the button.
            expect(screen.getByText(/token di spegnimento qui sotto|shutdown token below/i)).toBeInTheDocument();
        });
    });

    describe('providers the table has no key for', () => {
        it('leaves them in the select, disabled, saying what they need', async () => {
            // Hiding them would mean nobody ever discovers Gemini was an option;
            // offering them as usual means saving a config that stops mid-session.
            server.use(...baseHandlers(settings()));
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            const blocked = await screen.findAllByRole('option', { name: /gemini.*(serve una chiave|a key is needed)/i });
            expect(blocked.length).toBeGreaterThan(0);
            blocked.forEach((entry) => expect(entry).toBeDisabled());
        });

        it('offers a configured provider, and Ollama without any key', async () => {
            server.use(...baseHandlers(settings()));
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            const openai = await screen.findAllByRole('option', { name: /^OpenAI$/ });
            expect(openai[0]).toBeEnabled();
            // Its models run on the table's own machine: there is no key to ask for.
            const ollama = screen.getAllByRole('option', { name: /ollama/i })
                .filter((entry) => !entry.textContent?.match(/serve una chiave|a key is needed/i));
            expect(ollama[0]).toBeEnabled();
        });

        it('puts the remedy one click away', async () => {
            server.use(...baseHandlers(settings()));
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            const links = await screen.findAllByRole('link', { name: /aggiungi la chiave|add the .* key/i });
            expect(links[0]).toHaveAttribute('href', '#ai-key-gemini');
        });

        it('names the phases instead of printing their ids', async () => {
            server.use(...baseHandlers(settings()));
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            await screen.findByText(/4f2a/);
            expect(screen.queryByText('narrativeFilter')).not.toBeInTheDocument();
        });
    });

    describe('the checklist at the top', () => {
        it('names each gap separately, with its own remedy', async () => {
            server.use(...baseHandlers(settings(), transcription({ usable: false, reason: 'NOT_CONFIGURED' })));
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            // One red line naming a key told nothing about the other three gaps.
            const checklist = await screen.findByRole('region', { name: /colpo d.occhio|at a glance/i });
            expect(checklist).toHaveTextContent(/gemini/i);
            expect(checklist).toHaveTextContent(/nessun motore scelto|no engine chosen/i);
            expect(checklist).toHaveTextContent(/ancora nessuna campagna|no campaign on this server/i);
        });

        it('invites whoever can act, and only them', async () => {
            server.use(...baseHandlers(settings({ can_manage: false })));
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            await screen.findByText(/4f2a/);
            expect(screen.queryByRole('link', { name: /riprendi la configurazione|pick up the configuration/i }))
                .not.toBeInTheDocument();
        });

        it('says nothing is missing once everything is in place', async () => {
            server.use(...baseHandlers(
                settings({ ready: true, missing_providers: [], fast: { provider: 'openai', model: 'gpt-5.4-mini' } }),
                transcription({ usable: true, reason: null }),
            ));
            server.use(jsonGet('/guilds/g1/campaigns', [{ id: 1, name: 'Il Trono', is_active: 1 }]));
            renderWithProviders(<GuildAiSettingsPage />, { route: ROUTE, path: PATH });

            expect(await screen.findByText(/non manca niente|nothing missing/i)).toBeInTheDocument();
        });
    });
});
