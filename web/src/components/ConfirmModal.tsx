import type { ReactNode } from 'react';
import { useT } from '../i18n';
import { Modal } from './Modal';

/**
 * Confirmation of a destructive action.
 *
 * It grew out of the quest deletion confirmation block: with entity, event and
 * fragment deletion the same structure would be copied four times, and every
 * copy is a chance to forget the irreversibility warning or the busy state on
 * the buttons.
 */
export function ConfirmModal({
    open,
    title,
    question,
    consequences,
    busy,
    error,
    confirmLabel,
    busyLabel,
    onConfirm,
    onClose,
}: {
    open: boolean;
    title: string;
    question: string;
    /** What the action entails, beyond what the user asked for. */
    consequences?: ReactNode;
    busy: boolean;
    error?: string | null;
    confirmLabel: string;
    busyLabel: string;
    onConfirm: () => void;
    onClose: () => void;
}) {
    const t = useT();

    return (
        <Modal open={open} onClose={() => !busy && onClose()} title={title}>
            <div className="confirm-modal">
                <h2>{title}</h2>
                <p>{question}</p>
                {consequences && <div className="confirm-modal__consequences">{consequences}</div>}
                <p className="confirm-modal__warning">{t.crud.irreversible}</p>
                {error && <p role="alert" className="form-error">{error}</p>}
                <div className="modal-actions">
                    <button type="button" onClick={onClose} disabled={busy}>
                        {t.crud.cancel}
                    </button>
                    <button type="button" className="danger-button" onClick={onConfirm} disabled={busy}>
                        {busy ? busyLabel : confirmLabel}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
