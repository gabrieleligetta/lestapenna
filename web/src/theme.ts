/** What the user picked. 'system' follows the OS and is the default. */
export type ThemePreference = 'system' | 'light' | 'dark';

/** What actually ends up on <html data-theme>. */
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'lp_theme';

export const THEME_PREFERENCES: ThemePreference[] = ['system', 'light', 'dark'];

export function detectThemePreference(): ThemePreference {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

export function persistThemePreference(preference: ThemePreference): void {
    localStorage.setItem(STORAGE_KEY, preference);
}

export function systemTheme(): ResolvedTheme {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
    return preference === 'system' ? systemTheme() : preference;
}

/**
 * Stamps the resolved theme on <html>, always — including for 'system'.
 *
 * That is what lets index.css carry a single `:root[data-theme='dark']` block.
 * The alternative (a bare `@media (prefers-color-scheme: dark)` plus an
 * override selector) needs the whole dark palette written twice, and every
 * token added in one block and forgotten in the other silently breaks contrast
 * in one theme.
 */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
    const resolved = resolveTheme(preference);
    document.documentElement.setAttribute('data-theme', resolved);
    return resolved;
}

/** Keeps `system` honest when the OS flips while the tab is open. */
export function watchSystemTheme(onChange: () => void): () => void {
    const list = window.matchMedia('(prefers-color-scheme: dark)');
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
}
