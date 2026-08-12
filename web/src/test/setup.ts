import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Node 22 defines its own `localStorage` global that stays undefined unless the
// process is started with --localstorage-file, and it wins over jsdom's: inside a
// test `window.sessionStorage` is a real Storage while `window.localStorage` is
// undefined. Locale and theme both read it on mount, so it needs a stand-in.
if (!window.localStorage) {
    const entries = new Map<string, string>();
    const storage: Storage = {
        get length() {
            return entries.size;
        },
        key: (i: number) => [...entries.keys()][i] ?? null,
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => void entries.set(key, String(value)),
        removeItem: (key: string) => void entries.delete(key),
        clear: () => entries.clear(),
    };
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
}

// jsdom has no matchMedia at all, and useMediaQuery reads it during render.
// The stub reports "does not match", so components render their mobile layout
// unless a test overrides window.matchMedia itself.
if (!window.matchMedia) {
    window.matchMedia = (query: string): MediaQueryList =>
        ({
            matches: false,
            media: query,
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
        }) as MediaQueryList;
}

// jsdom ships no EventSource, and the shell subscribes to one on mount for the
// live job stream. The stub connects to nothing on purpose: the stream is only
// ever a hint to refetch, so every component must work without it — which is
// exactly what these tests then verify.
if (!('EventSource' in globalThis)) {
    class StubEventSource {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSED = 2;
        readonly readyState = StubEventSource.CONNECTING;
        addEventListener(): void {}
        removeEventListener(): void {}
        close(): void {}
    }
    Object.defineProperty(globalThis, 'EventSource', {
        value: StubEventSource,
        configurable: true,
    });
}

// Vitest's globals are off, so RTL's automatic cleanup (which hooks a global
// afterEach) never registers itself — do it explicitly or DOM leaks across tests.
afterEach(() => {
    cleanup();
});
