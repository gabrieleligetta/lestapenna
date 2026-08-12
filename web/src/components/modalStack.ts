import { useEffect, useSyncExternalStore } from 'react';

/**
 * How many modals are open, app-wide.
 *
 * `Modal` used to document that "the caller is responsible for marking the
 * background inert" — and exactly one of its seven callers did, which meant the
 * other six left the whole app in the tab order and the screen-reader tree
 * behind an open dialog. A contract nobody follows is not a contract.
 *
 * The count lives outside React because the two parties are far apart in the
 * tree: any `Modal`, anywhere, and the shell that has to go inert. A counter
 * rather than a boolean, because a dialog may open on top of another one and the
 * first one closing must not un-inert the app underneath the second.
 */
let openCount = 0;
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Registers an open modal for as long as `open` stays true. */
export function useRegisterModal(open: boolean): void {
    useEffect(() => {
        if (!open) return;
        openCount += 1;
        emit();
        return () => {
            openCount -= 1;
            emit();
        };
    }, [open]);
}

/** True while any modal is open. Read by the shell to mark itself inert. */
export function useAnyModalOpen(): boolean {
    return useSyncExternalStore(
        subscribe,
        () => openCount > 0,
        () => false,
    );
}
