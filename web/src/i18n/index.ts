import { createContext, useContext } from 'react';
import type { Messages } from './messages';
import { en } from './en';
import { it } from './it';
import { es } from './es';
import { fr } from './fr';
import { de } from './de';
import { ptBR } from './pt-BR';

export type Locale = 'en' | 'it' | 'es' | 'fr' | 'de' | 'pt-BR';

export const LOCALES: Record<Locale, Messages> = { en, it, es, fr, de, 'pt-BR': ptBR };

const STORAGE_KEY = 'lp_locale';

export function detectLocale(): Locale {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored in LOCALES) return stored as Locale;

    const browser = navigator.language;
    if (browser.toLowerCase().startsWith('pt')) return 'pt-BR';
    const short = browser.slice(0, 2).toLowerCase();
    if (short in LOCALES) return short as Locale;
    return 'en';
}

export function persistLocale(locale: Locale): void {
    localStorage.setItem(STORAGE_KEY, locale);
}

export const LocaleContext = createContext<{ locale: Locale; setLocale: (l: Locale) => void }>({
    locale: 'en',
    setLocale: () => {},
});

/** Returns the full message tree for the active locale — no string-path lookups needed, TS gives full autocomplete. */
export function useT(): Messages {
    const { locale } = useContext(LocaleContext);
    return LOCALES[locale];
}

export function useLocale() {
    return useContext(LocaleContext);
}
