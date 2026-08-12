import { useTheme } from '../context/ThemeContext';
import { THEME_PREFERENCES, type ThemePreference } from '../theme';
import { useT } from '../i18n';
import { Icon, type IconName } from './icons';

const GLYPH: Record<ThemePreference, IconName> = {
    system: 'system',
    light: 'light',
    dark: 'dark',
};

export function ThemeToggle() {
    const { preference, setPreference } = useTheme();
    const t = useT();

    // Cycles system → light → dark → system. Three states in one control,
    // because "follow the OS" has to stay reachable once you have overridden it.
    function next() {
        const i = THEME_PREFERENCES.indexOf(preference);
        setPreference(THEME_PREFERENCES[(i + 1) % THEME_PREFERENCES.length]);
    }

    return (
        <button type="button" className="icon-button" onClick={next} title={t.theme.label} aria-label={`${t.theme.label}: ${t.theme[preference]}`}>
            <Icon name={GLYPH[preference]} />
        </button>
    );
}
