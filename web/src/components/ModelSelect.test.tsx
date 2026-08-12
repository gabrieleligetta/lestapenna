import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelSelect } from './ModelSelect';
import { renderWithProviders } from '../test/renderWithProviders';
import type { AiModelOption } from '../api/types';

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

const OPTIONS: AiModelOption[] = [
    option({
        id: 'gpt-5.6-terra', label: 'Equilibrato', recommended: true,
        input_per_million: 2.5, output_per_million: 15, context_tokens: 1_050_000,
    }),
    option({ id: 'gpt-5.4-nano', input_per_million: 0.2, output_per_million: 1.25 }),
    option({ id: 'un-modello-senza-listino' }),
];

describe('ModelSelect', () => {
    it('shows the price next to each model, where the choice is made', async () => {
        renderWithProviders(<ModelSelect value="gpt-5.6-terra" options={OPTIONS} onChange={() => {}} />);

        // The whole point of the figure being here rather than only on an
        // invoice: one option visibly costs a fraction of the other.
        expect(await screen.findByRole('option', { name: /2\.5 in \/ \$15 out per 1M tokens/ }))
            .toBeInTheDocument();
        expect(screen.getByRole('option', { name: /0\.2 in \/ \$1\.25 out per 1M tokens/ }))
            .toBeInTheDocument();
    });

    it('says a rate is unknown instead of leaving it blank or calling it free', async () => {
        renderWithProviders(<ModelSelect value="gpt-5.4-nano" options={OPTIONS} onChange={() => {}} />);

        expect(await screen.findByRole('option', { name: /un-modello-senza-listino · price unknown/ }))
            .toBeInTheDocument();
    });

    it('separates what we suggest from the rest', async () => {
        renderWithProviders(<ModelSelect value="gpt-5.4-nano" options={OPTIONS} onChange={() => {}} />);

        const select = await screen.findByRole('combobox');
        const groups = Array.from(select.querySelectorAll('optgroup')).map((g) => g.label);
        expect(groups).toContain('Recommended');
        expect(groups).toContain('Other models');
    });

    it('keeps a hand-typed model instead of resetting it, and flags it', async () => {
        renderWithProviders(
            <ModelSelect value="modello-scritto-a-mano" options={OPTIONS} onChange={() => {}} />,
        );

        // The catalogue is curated, not exhaustive: a model it does not carry
        // may be perfectly valid, or withdrawn. Saying we cannot tell beats
        // dropping it silently.
        expect(await screen.findByDisplayValue('modello-scritto-a-mano')).toBeInTheDocument();
        expect(screen.getByText('no longer listed')).toBeInTheDocument();
    });

    it('lets someone type a model the catalogue does not carry', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithProviders(<ModelSelect value="gpt-5.4-nano" options={OPTIONS} onChange={onChange} />);

        await user.selectOptions(await screen.findByRole('combobox'), '__custom');

        // Choosing the escape hatch clears the value so the free-text field
        // appears empty rather than pre-filled with the previous model.
        expect(onChange).toHaveBeenCalledWith('');
    });

    it('offers "no choice" only when the caller allows it', async () => {
        const { unmount } = renderWithProviders(
            <ModelSelect value="" options={OPTIONS} onChange={() => {}} allowEmpty emptyLabel="Same as the server" />,
        );
        expect(await screen.findByRole('option', { name: 'Same as the server' })).toBeInTheDocument();
        unmount();

        renderWithProviders(<ModelSelect value="gpt-5.4-nano" options={OPTIONS} onChange={() => {}} />);
        expect(screen.queryByRole('option', { name: 'Same as the server' })).not.toBeInTheDocument();
    });

    it('words the table\'s own hardware as a different kind of cost, not as zero', async () => {
        renderWithProviders(
            <ModelSelect
                value="qwen3:8b"
                options={[option({ id: 'qwen3:8b', runs_on_your_hardware: true })]}
                onChange={() => {}}
            />,
        );

        expect(await screen.findByRole('option', { name: /qwen3:8b · on your hardware/ }))
            .toBeInTheDocument();
    });
});
