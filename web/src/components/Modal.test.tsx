import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import { Modal } from './Modal';
import { useAnyModalOpen } from './modalStack';

describe('Modal', () => {
    /**
     * The close button used to be labelled with an English template literal, so
     * every dialog in the app announced it in English whatever the locale. The
     * compiler cannot see that: only a test can.
     */
    it('labels its close button in the active locale', () => {
        renderWithProviders(
            <Modal open onClose={() => {}} title="Impostazioni">
                <p>body</p>
            </Modal>,
            { locale: 'it' },
        );

        expect(screen.getByRole('button', { name: 'Chiudi Impostazioni' })).toBeInTheDocument();
    });

    /**
     * The shell going inert used to be the caller's job; six of seven dialogs
     * never did it. Now `Modal` registers itself and `AppShell` reads that.
     */
    it('registers itself so the shell can go inert, and unregisters on close', () => {
        function Probe() {
            return <span data-testid="probe">{String(useAnyModalOpen())}</span>;
        }

        const { rerender } = renderWithProviders(
            <>
                <Probe />
                <Modal open={false} onClose={() => {}} title="Dialog"><p>body</p></Modal>
            </>,
        );
        expect(screen.getByTestId('probe')).toHaveTextContent('false');

        rerender(
            <>
                <Probe />
                <Modal open onClose={() => {}} title="Dialog"><p>body</p></Modal>
            </>,
        );
        expect(screen.getByTestId('probe')).toHaveTextContent('true');

        rerender(
            <>
                <Probe />
                <Modal open={false} onClose={() => {}} title="Dialog"><p>body</p></Modal>
            </>,
        );
        expect(screen.getByTestId('probe')).toHaveTextContent('false');
    });

    it('closes on Escape', () => {
        const onClose = vi.fn();
        renderWithProviders(
            <Modal open onClose={onClose} title="Dialog">
                <p>body</p>
            </Modal>,
        );

        screen.getByRole('dialog').dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
        expect(onClose).toHaveBeenCalled();
    });
});
