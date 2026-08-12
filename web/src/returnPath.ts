const KEY = 'lp_return_to';

/**
 * Where to land after logging in.
 *
 * React Router's `state` cannot carry this: logging in leaves the SPA entirely
 * (browser → API → Discord → API → back), so anything held in memory is gone by
 * the time we return. sessionStorage survives exactly that round trip and dies
 * with the tab.
 */
export function rememberReturnPath(path: string): void {
    if (!isSafeInternalPath(path) || path === '/') return;
    sessionStorage.setItem(KEY, path);
}

export function peekReturnPath(): string | null {
    const stored = sessionStorage.getItem(KEY);
    return stored && isSafeInternalPath(stored) ? stored : null;
}

export function clearReturnPath(): void {
    sessionStorage.removeItem(KEY);
}

/**
 * `//evil.example` is a valid protocol-relative URL: handed to <Navigate> it
 * leaves the site. Only a single leading slash is an in-app path.
 */
function isSafeInternalPath(path: string): boolean {
    return path.startsWith('/') && !path.startsWith('//');
}
