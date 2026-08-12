import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ThemeContext } from './ThemeContext';
import {
    applyTheme,
    detectThemePreference,
    persistThemePreference,
    watchSystemTheme,
    type ThemePreference,
} from '../theme';

/** Owns the theme preference: reads it back on load, writes it on change, and keeps <html data-theme> in step. */
export function ThemeProvider({ children }: { children: ReactNode }) {
    const [preference, setPreferenceState] = useState<ThemePreference>(detectThemePreference);

    const setPreference = useCallback((next: ThemePreference) => {
        setPreferenceState(next);
        persistThemePreference(next);
        applyTheme(next);
    }, []);

    // 'system' has to keep tracking the OS after load, not just at startup.
    useEffect(() => {
        if (preference !== 'system') return;
        return watchSystemTheme(() => applyTheme('system'));
    }, [preference]);

    return <ThemeContext.Provider value={{ preference, setPreference }}>{children}</ThemeContext.Provider>;
}
