import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { useRegisterModal } from './modalStack';
import { useDialogBehaviour } from './useDialogBehaviour';

interface ModalProps {
    open: boolean;
    onClose: () => void;
    /** Accessible name of the dialog. */
    title: string;
    children: ReactNode;
    /** Render a wider variant (e.g. for the screenshot editor). */
    wide?: boolean;
}

/**
 * A reusable, accessible modal dialog. Renders a scrim + a centred dialog with
 * `role="dialog" aria-modal`, traps Tab within it, closes on Escape and
 * restores focus to the element that had focus when it opened.
 *
 * It portals to `document.body` and registers itself in `modalStack`, so the app
 * shell can mark itself inert while it is open. That used to be the caller's
 * job, documented here and honoured by one caller out of seven — the other six
 * dialogs left the entire app reachable by Tab and by a screen reader behind the
 * scrim. Being outside the shell in the DOM is what makes the shell safe to
 * blank out: a dialog rendered inside it would go inert along with it.
 */
export function Modal({ open, onClose, title, children, wide }: ModalProps) {
    const t = useT();
    const dialogRef = useDialogBehaviour(open, onClose);
    useRegisterModal(open);

    if (!open) return null;

    return createPortal(
        <div className="modal-overlay" onClick={onClose}>
            <div
                ref={dialogRef}
                className={wide ? 'modal modal--wide' : 'modal'}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onClick={(event) => event.stopPropagation()}
            >
                <button
                    type="button"
                    className="modal__close"
                    onClick={onClose}
                    aria-label={title ? t.common.closeNamed(title) : t.common.close}
                >
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
                        <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                </button>
                {children}
            </div>
        </div>,
        document.body,
    );
}
