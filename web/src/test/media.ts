/**
 * Drives useMediaQuery from a pretend viewport width.
 *
 * The default stub in setup.ts answers "no match" to everything, which pins
 * components to their mobile layout; call this to test the other side of a
 * breakpoint. Only `(min-width: Npx)` is understood — that is all App.css uses.
 */
export function setViewportWidth(width: number): void {
    window.matchMedia = (query: string): MediaQueryList => {
        const min = /\(min-width:\s*(\d+)px\)/.exec(query);
        const matches = min ? width >= Number(min[1]) : false;
        return {
            matches,
            media: query,
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
        } as MediaQueryList;
    };
}
