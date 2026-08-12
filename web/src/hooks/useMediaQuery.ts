import { useCallback, useSyncExternalStore } from 'react';

/**
 * Subscribes to a media query.
 *
 * `useSyncExternalStore` rather than useState+useEffect: the match is read
 * during render, so the first paint is already correct instead of flashing the
 * mobile layout on a desktop viewport. The server snapshot returns false —
 * there is no SSR here, but the third argument is what jsdom falls back to when
 * matchMedia is missing.
 */
export function useMediaQuery(query: string): boolean {
    const subscribe = useCallback(
        (onStoreChange: () => void) => {
            const list = window.matchMedia(query);
            list.addEventListener('change', onStoreChange);
            return () => list.removeEventListener('change', onStoreChange);
        },
        [query],
    );

    return useSyncExternalStore(
        subscribe,
        () => window.matchMedia(query).matches,
        () => false,
    );
}
