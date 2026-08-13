import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CampaignAiAdvanced } from './CampaignAiAdvanced';
import { renderWithProviders } from '../test/renderWithProviders';
import { http, HttpResponse, jsonGet, server } from '../test/server';
import type { AiModelOption, AiPhaseConfig, AiPhaseOverride, ProviderModels } from '../api/types';

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
    quality: [
        option({ id: 'gpt-5.6-terra', recommended: true, input_per_million: 2.5, output_per_million: 15 }),
        option({ id: 'gpt-5.6-sol', input_per_million: 5, output_per_million: 30 }),
    ],
    fast: [option({ id: 'gpt-5.4-nano', input_per_million: 0.2, output_per_million: 1.25 })],
    transcription: [],
    image: [],
    refreshed_at: 1_780_000_000_000,
};

const EFFECTIVE: AiPhaseConfig[] = [
    { phase: 'summary', provider: 'gemini', model: 'gemini-3.1-pro-preview', tier: 'quality' },
    { phase: 'narrativeFilter', provider: 'gemini', model: 'gemini-3-flash-preview', tier: 'fast' },
    // The server sends it, because the effective config includes it. This
    // section must still refuse to offer it as an override.
    { phase: 'embedding', provider: 'gemini', model: 'gemini-embedding-001', tier: null },
];

function estimate(body: Record<string, unknown>) {
    return http.get('/api/v1/campaigns/1/ai-settings/phase-estimate', () => HttpResponse.json({
        phase: 'summary',
        provider: 'openai',
        model: 'gpt-5.6-terra',
        audio_minutes: 240,
        input_tokens: 384_000,
        output_tokens: 144_000,
        cost_usd: 3.12,
        cost_eur: 2.86,
        pricing_source: 'builtin',
        calibrated: false,
        runs_on_your_hardware: false,
        ...body,
    }));
}

function renderAdvanced(readOnly = false, overrides: AiPhaseOverride[] = []) {
    return renderWithProviders(
        <CampaignAiAdvanced
            campaignId="1"
            guildId="g1"
            effective={EFFECTIVE}
            overrides={overrides}
            readOnly={readOnly}
        />,
    );
}

/** Opening the collapsed section is the precondition of every case here. */
async function open(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByText('Advanced settings'));
}

describe('CampaignAiAdvanced', () => {
    beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
    afterEach(() => server.resetHandlers());
    afterAll(() => server.close());

    it('names the phases instead of printing their ids', async () => {
        const user = userEvent.setup();
        server.use(jsonGet('/guilds/g1/ai-settings/models', MODELS));
        renderAdvanced();
        await open(user);

        // `narrativeFilter` asks the reader to know the pipeline in order to
        // configure it.
        expect(await screen.findByText('Narrative filter')).toBeInTheDocument();
        expect(screen.getByText('Narrative writing')).toBeInTheDocument();
        expect(screen.queryByText('narrativeFilter')).not.toBeInTheDocument();
    });

    it('offers the models of the phase\'s own group, from a select', async () => {
        const user = userEvent.setup();
        server.use(jsonGet('/guilds/g1/ai-settings/models', MODELS), estimate({}));
        renderAdvanced();
        await open(user);

        const providers = await screen.findAllByLabelText('Provider');
        await user.selectOptions(providers[0], 'openai');

        // `summary` is a quality phase: the fast models are not its choice.
        expect(await screen.findByRole('option', { name: /gpt-5\.6-terra/ })).toBeInTheDocument();
        expect(screen.queryByRole('option', { name: /gpt-5\.4-nano/ })).not.toBeInTheDocument();
    });

    it('shows what the choice would cost, for that phase alone', async () => {
        const user = userEvent.setup();
        server.use(jsonGet('/guilds/g1/ai-settings/models', MODELS), estimate({}));
        renderAdvanced();
        await open(user);

        const providers = await screen.findAllByLabelText('Provider');
        await user.selectOptions(providers[0], 'openai');
        await user.selectOptions((await screen.findAllByLabelText('Model'))[0], 'gpt-5.6-terra');

        expect(await screen.findByText(/for this phase on a 4h session/)).toBeInTheDocument();
        // An estimate from our constants must not read as a measurement.
        expect(screen.getByText(/Based on average figures/)).toBeInTheDocument();
    });

    it('says an unknown rate has no cost, rather than showing zero', async () => {
        const user = userEvent.setup();
        server.use(
            jsonGet('/guilds/g1/ai-settings/models', MODELS),
            estimate({ cost_usd: null, cost_eur: null, pricing_source: 'unknown' }),
        );
        renderAdvanced();
        await open(user);

        const providers = await screen.findAllByLabelText('Provider');
        await user.selectOptions(providers[0], 'openai');
        await user.selectOptions((await screen.findAllByLabelText('Model'))[0], 'gpt-5.6-terra');

        expect(await screen.findByText(/We do not know this model/)).toBeInTheDocument();
        expect(screen.queryByText(/€0\.00/)).not.toBeInTheDocument();
    });

    it('saves only the phases that have a model', async () => {
        const user = userEvent.setup();
        let sent: { overrides: unknown[] } | null = null;
        server.use(
            jsonGet('/guilds/g1/ai-settings/models', MODELS),
            estimate({}),
            http.put('/api/v1/campaigns/1/ai-settings/phases', async ({ request }) => {
                sent = (await request.json()) as { overrides: unknown[] };
                return HttpResponse.json(sent.overrides);
            }),
        );
        renderAdvanced();
        await open(user);

        const providers = await screen.findAllByLabelText('Provider');
        // A provider chosen and no model yet: a half-filled row would save a
        // phase pointed at nothing.
        await user.selectOptions(providers[0], 'openai');
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(sent).toEqual({ overrides: [] }));
    });

    it('does not offer indexing as an override, and says where it is changed', async () => {
        // The row used to be here and was worse than missing: it offered the
        // text catalogue — models with no embeddings endpoint — and wrote a
        // setting nothing reads, since embedding is pinned to the campaign.
        const user = userEvent.setup();
        server.use(jsonGet('/guilds/g1/ai-settings/models', MODELS));
        renderAdvanced();
        await open(user);

        expect(screen.queryByText('Indexing')).not.toBeInTheDocument();
        expect(screen.getByText(/Campaign memory \(RAG\)/)).toBeInTheDocument();
    });

    it('never sends an embedding override, even from a stale draft', async () => {
        const user = userEvent.setup();
        let sent: Record<string, unknown> | null = null;
        server.use(
            jsonGet('/guilds/g1/ai-settings/models', MODELS),
            http.put('/api/v1/campaigns/1/ai-settings/phases', async ({ request }) => {
                sent = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json([]);
            }),
        );
        renderAdvanced(false, [{ phase: 'embedding', provider: 'gemini', model: 'gemini-embedding-001' }]);
        await open(user);

        await user.click(screen.getByRole('button', { name: 'Save' }));

        // The server refuses it with a 400; the page must not be the thing that
        // triggers one on a plain save.
        await waitFor(() => expect(sent).toEqual({ overrides: [] }));
    });

    it('leaves nothing editable to someone who cannot write', async () => {
        const user = userEvent.setup();
        server.use(jsonGet('/guilds/g1/ai-settings/models', MODELS));
        renderAdvanced(true);
        await open(user);

        for (const select of await screen.findAllByRole('combobox')) {
            expect(select).toBeDisabled();
        }
        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
});
