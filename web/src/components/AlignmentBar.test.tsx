import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { AlignmentBar } from './AlignmentBar';
import { renderWithProviders } from '../test/renderWithProviders';

describe('AlignmentBar', () => {
    it('exposes the score as a meter', () => {
        renderWithProviders(<AlignmentBar axis="moral" score={72} label="GOOD" />);

        const meter = screen.getByRole('meter', { name: 'Moral' });
        expect(meter).toHaveAttribute('aria-valuenow', '72');
        expect(meter).toHaveAttribute('aria-valuemin', '-100');
        expect(meter).toHaveAttribute('aria-valuemax', '100');
    });

    it('renders the label the API assigned, never one it re-derives', () => {
        // 10 is inside the ±25 neutral band, so a component that recomputed the
        // label from the score would print "Neutral" here. The thresholds live in
        // src/utils/alignmentUtils.ts and a second copy would drift the moment
        // they are tuned, so the API's answer wins.
        renderWithProviders(<AlignmentBar axis="moral" score={10} label="GOOD" />);

        // Asserted on aria-valuetext rather than by text: "Good" is also the
        // caption of the positive pole, so a bare text query matches twice.
        expect(screen.getByRole('meter', { name: 'Moral' })).toHaveAttribute('aria-valuetext', 'Good (10)');
        expect(screen.queryByText('Neutral')).toBeNull();
    });

    it('clamps a score that overshoots the track', () => {
        renderWithProviders(<AlignmentBar axis="ethical" score={-450} label="CHAOTIC" />);

        const meter = screen.getByRole('meter', { name: 'Ethical' });
        expect(meter).toHaveAttribute('aria-valuenow', '-100');
    });

    it('fills leftward for a negative score and rightward for a positive one', () => {
        const { unmount } = renderWithProviders(<AlignmentBar axis="moral" score={-50} label="EVIL" />);
        let fill = document.querySelector<HTMLElement>('.alignment-fill');
        expect(fill).toHaveClass('alignment-fill-neg');
        expect(fill!.style.left).toBe('25%');
        expect(fill!.style.width).toBe('25%');
        unmount();

        renderWithProviders(<AlignmentBar axis="moral" score={50} label="GOOD" />);
        fill = document.querySelector<HTMLElement>('.alignment-fill');
        expect(fill).toHaveClass('alignment-fill-pos');
        expect(fill!.style.left).toBe('50%');
        expect(fill!.style.width).toBe('25%');
    });

    it('names the poles of the axis it is showing', () => {
        renderWithProviders(<AlignmentBar axis="ethical" score={0} label="NEUTRAL" />);

        expect(screen.getByText('Chaotic')).toBeInTheDocument();
        expect(screen.getByText('Lawful')).toBeInTheDocument();
    });
});
