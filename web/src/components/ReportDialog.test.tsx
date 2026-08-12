import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportDialog } from './ReportDialog';
import { ScreenshotEditor } from './ScreenshotEditor';
import { renderWithProviders } from '../test/renderWithProviders';
import { HttpResponse, http, server } from '../test/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** The Screen Capture API is absent in jsdom by default — the dialog must fall
 * back to upload-only. Some tests install a stub via this helper. */
function installGetDisplayMedia(impl: () => Promise<MediaStream>) {
    const mediaDevices = { getDisplayMedia: impl } as unknown as MediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', {
        value: mediaDevices,
        configurable: true,
    });
}

function restoreMediaDevices() {
    // @ts-expect-error -- delete an installed property (no-op if absent)
    delete navigator.mediaDevices;
}

/** jsdom has no canvas implementation: stub the 2D context + toBlob so the
 * ScreenshotEditor can run its render/encode path without a real rasteriser. */
function stubCanvas() {
    const noop = () => {};
    const ctx = {
        setTransform: noop,
        clearRect: noop,
        drawImage: noop,
        save: noop,
        restore: noop,
        beginPath: noop,
        closePath: noop,
        moveTo: noop,
        lineTo: noop,
        stroke: noop,
        strokeRect: noop,
        fillRect: noop,
        arc: noop,
        lineWidth: 1,
        strokeStyle: '',
        fillStyle: '',
        globalAlpha: 1,
        lineCap: '',
        lineJoin: '',
    } as unknown as CanvasRenderingContext2D;
    const getCtx = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    const toBlob = vi
        .spyOn(HTMLCanvasElement.prototype, 'toBlob')
        .mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback) {
            cb(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }));
        });
    return () => {
        getCtx.mockRestore();
        toBlob.mockRestore();
    };
}

describe('ReportDialog — screenshot source', () => {
    afterEach(() => restoreMediaDevices());

    it('hides the Capture toggle and falls back to upload when getDisplayMedia is unavailable', () => {
        restoreMediaDevices(); // ensure no mediaDevices
        renderWithProviders(<ReportDialog open onClose={() => {}} />);

        expect(screen.queryByRole('button', { name: 'Capture' })).not.toBeInTheDocument();
        expect(screen.getByText('Choose an image or drop it here')).toBeInTheDocument();
        expect(
            screen.getByText(
                'Screen capture is not available in this browser — please upload an image instead.',
            ),
        ).toBeInTheDocument();
    });

    it('shows the Upload | Capture toggle when getDisplayMedia is available and switches modes', async () => {
        installGetDisplayMedia(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
        const user = userEvent.setup();
        renderWithProviders(<ReportDialog open onClose={() => {}} />);

        // Capture mode: shows the "Capture screen" call-to-action.
        await user.click(screen.getByRole('button', { name: 'Capture' }));
        expect(screen.getByRole('button', { name: /Capture screen/ })).toBeInTheDocument();

        // Upload mode: shows the dropzone again.
        await user.click(screen.getByRole('button', { name: 'Upload' }));
        expect(screen.getByText('Choose an image or drop it here')).toBeInTheDocument();
    });

    it('preselects Capture (not Upload) when getDisplayMedia is available', () => {
        installGetDisplayMedia(() =>
            Promise.reject(new DOMException('denied', 'NotAllowedError')),
        );
        renderWithProviders(<ReportDialog open onClose={() => {}} />);

        // The capture call-to-action is shown immediately, the upload dropzone is not.
        expect(screen.getByRole('button', { name: /Capture screen/ })).toBeInTheDocument();
        expect(screen.queryByText('Choose an image or drop it here')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Capture' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'Upload' })).toHaveAttribute('aria-pressed', 'false');
    });
});

describe('ReportDialog — capture preserves form fields', () => {
    afterEach(() => restoreMediaDevices());

    it('does not clear already-filled fields when the user triggers screen capture', async () => {
        // Cancelling the browser's screen-source picker returns the dialog to the
        // form; the fields typed before must still be there.
        installGetDisplayMedia(() =>
            Promise.reject(new DOMException('denied', 'NotAllowedError')),
        );
        const user = userEvent.setup();
        renderWithProviders(<ReportDialog open onClose={() => {}} />);

        await user.type(screen.getByLabelText('Description'), 'header overlaps');
        await user.type(screen.getByLabelText('Steps to reproduce'), 'resize to 360px');
        await user.selectOptions(screen.getByLabelText('Severity'), 'high');

        // Switch to capture mode and fire the screen-capture action.
        await user.click(screen.getByRole('button', { name: 'Capture' }));
        await user.click(screen.getByRole('button', { name: /Capture screen/ }));

        // Picker cancelled → back to the form.
        await screen.findByRole('button', { name: 'Send report' });

        expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('header overlaps');
        expect((screen.getByLabelText('Steps to reproduce') as HTMLTextAreaElement).value).toBe('resize to 360px');
        expect((screen.getByLabelText('Severity') as HTMLSelectElement).value).toBe('high');
    });
});

describe('ReportDialog — submit with uploaded screenshot', () => {
    it('posts the screenshot as multipart FormData to /api/v1/reports', async () => {
        const user = userEvent.setup();
        let body = '';
        server.use(
            http.post('/api/v1/reports', async ({ request }) => {
                body = await request.text();
                return HttpResponse.json({ number: 1, id: '000001', status: 'open', createdAt: 1 });
            }),
        );

        renderWithProviders(<ReportDialog open onClose={() => {}} />);

        await user.type(screen.getByLabelText('Description'), 'the header overlaps on mobile');
        // The dialog portals to <body>, so it is queried from the document, not the render root.
        const input = screen.getByRole('dialog').querySelector('input[type="file"]') as HTMLInputElement;
        fireEvent.change(input, {
            target: { files: [new File(['pixels'], 'shot.png', { type: 'image/png' })] },
        });
        await user.click(screen.getByRole('button', { name: 'Send report' }));

        expect(await screen.findByText('Report #000001 sent. Thank you!')).toBeInTheDocument();
        // The screenshot is serialized as a multipart file part under field "screenshot".
        expect(body).toContain('name="screenshot"');
        expect(body).toContain('filename=');
        expect(body).toContain('Content-Type: image/png');
    });

    it('clears the previous screenshot when reopened after a successful submission', async () => {
        const user = userEvent.setup();
        server.use(
            http.post('/api/v1/reports', () =>
                HttpResponse.json({ number: 1, id: '000001', status: 'open', createdAt: 1 }),
            ),
        );
        // Upload-only path (no getDisplayMedia) so the dropzone is reachable.
        const { rerender } = renderWithProviders(
            <ReportDialog open onClose={() => {}} />,
        );

        await user.type(screen.getByLabelText('Description'), 'first report');
        const input = screen.getByRole('dialog').querySelector('input[type="file"]') as HTMLInputElement;
        fireEvent.change(input, {
            target: { files: [new File(['pixels'], 'shot.png', { type: 'image/png' })] },
        });
        // The preview is shown before submitting.
        expect(screen.getByRole('dialog').querySelector('img')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Send report' }));
        expect(await screen.findByText('Report #000001 sent. Thank you!')).toBeInTheDocument();

        // Close, then reopen the dialog for a second report.
        rerender(<ReportDialog open={false} onClose={() => {}} />);
        rerender(<ReportDialog open onClose={() => {}} />);

        // The success message and the previous screenshot preview are gone.
        expect(screen.queryByText('Report #000001 sent. Thank you!')).not.toBeInTheDocument();
        expect(screen.getByRole('dialog').querySelector('img')).not.toBeInTheDocument();
        expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('');
    });
});

describe('ScreenshotEditor — confirm', () => {
    it('emits a File (webp) when the user confirms', async () => {
        const restoreCanvas = stubCanvas();
        const onConfirm = vi.fn();
        const source = document.createElement('canvas');
        source.width = 400;
        source.height = 300;

        try {
            renderWithProviders(
                <ScreenshotEditor
                    source={source}
                    onConfirm={onConfirm}
                    onCancel={() => {}}
                    onRetake={() => {}}
                    t={{
                        editorTitle: 'Annotate screenshot',
                        editorHint: 'h',
                        toolCrop: 'Crop',
                        toolPen: 'Pen',
                        toolArrow: 'Arrow',
                        toolRect: 'Rectangle',
                        toolHighlight: 'Highlight',
                        colorLabel: 'Colour',
                        undo: 'Undo',
                        clear: 'Clear',
                        applyCrop: 'Apply crop',
                        cropHint: 'ch',
                        annotateHint: 'ah',
                        confirm: 'Confirm',
                        retake: 'Retake',
                        cancelEdit: 'Cancel',
                        sending: 'Sending…',
                    } as never}
                />,
            );

            fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
            await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
            const file = onConfirm.mock.calls[0][0] as File;
            expect(file).toBeInstanceOf(File);
            expect(file.type).toBe('image/webp');
            expect(file.name).toBe('screenshot.webp');
        } finally {
            restoreCanvas();
        }
    });
});