import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
    'button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Escape to close, Tab kept inside, focus given back on unmount.
 *
 * Shared with the image lightbox and the mobile navigation drawer, which need
 * the same keyboard contract but not the `.modal` chrome: a dialog that only
 * differs in how it looks must not differ in how it behaves. The drawer used to
 * carry its own copy of this, with a focusable selector that omitted `input` and
 * `textarea` — two implementations of one contract, disagreeing.
 */
export function useDialogBehaviour<T extends HTMLElement = HTMLDivElement>(
    open: boolean,
    onClose: () => void,
) {
    const dialogRef = useRef<T>(null);
    const previouslyFocused = useRef<HTMLElement | null>(null);
    const onCloseRef = useRef(onClose);

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        if (!open) return;
        previouslyFocused.current = document.activeElement as HTMLElement | null;

        const dialog = dialogRef.current;
        const firstFocusable = dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
        firstFocusable?.focus();

        function onKeyDown(event: KeyboardEvent) {
            if (event.key === 'Escape') {
                event.preventDefault();
                onCloseRef.current();
                return;
            }
            if (event.key !== 'Tab' || !dialogRef.current) return;
            const focusable = Array.from(
                dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
            ).filter((element) => !element.hasAttribute('disabled'));
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }

        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            previouslyFocused.current?.focus();
        };
    }, [open]);

    return dialogRef;
}
