import { createContext, useContext } from 'react';
import type { ThemePreference } from '../theme';

export const ThemeContext = createContext<{
    preference: ThemePreference;
    setPreference: (preference: ThemePreference) => void;
}>({
    preference: 'system',
    setPreference: () => {},
});

export function useTheme() {
    return useContext(ThemeContext);
}
