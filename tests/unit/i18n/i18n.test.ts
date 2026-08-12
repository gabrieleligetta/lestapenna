import {
    t, normalizeLocale, whisperLanguage, aiOutputDirective,
    SUPPORTED_LOCALES, Locale,
} from '../../../src/i18n';
import { en } from '../../../src/i18n/locales/en';

describe('i18n', () => {
    describe('t()', () => {
        it('translates into the requested language', () => {
            expect(t('it', 'common.errorTitle')).toBe('❌ Errore');
            expect(t('en', 'common.errorTitle')).toBe('❌ Error');
            expect(t('de', 'common.errorTitle')).toBe('❌ Fehler');
        });

        it('interpola i parametri {nome}', () => {
            const msg = t('en', 'dispatcher.adminOnly', { cmd: '$ascolta' });
            expect(msg).toContain('$ascolta');
            expect(msg).not.toContain('{cmd}');
        });

        it('leaves placeholders untouched when no parameter is given', () => {
            expect(t('en', 'common.executionError')).toContain('{cmd}');
        });
    });

    describe('dizionari', () => {
        it('every locale has all of en\'s keys (at runtime, beyond the TS constraint)', () => {
            const keys = Object.keys(en);
            for (const locale of SUPPORTED_LOCALES) {
                for (const key of keys) {
                    const value = t(locale as Locale, key as keyof typeof en);
                    expect(typeof value).toBe('string');
                    expect(value.length).toBeGreaterThan(0);
                }
            }
        });

        it('every translation keeps the placeholders of the English text', () => {
            const placeholders = (value: string) =>
                (value.match(/\{\w+\}/g) ?? []).sort();

            for (const [key, englishValue] of Object.entries(en)) {
                const expected = placeholders(englishValue);
                for (const locale of SUPPORTED_LOCALES) {
                    expect(placeholders(t(locale, key as keyof typeof en))).toEqual(expected);
                }
            }
        });
    });

    describe('normalizeLocale()', () => {
        it('mappa i locale Discord sui supportati', () => {
            expect(normalizeLocale('en-US')).toBe('en');
            expect(normalizeLocale('en-GB')).toBe('en');
            expect(normalizeLocale('es-ES')).toBe('es');
            expect(normalizeLocale('es-419')).toBe('es');
            expect(normalizeLocale('pt-BR')).toBe('pt-BR');
            expect(normalizeLocale('pt')).toBe('pt-BR');
            expect(normalizeLocale('it')).toBe('it');
            expect(normalizeLocale('IT')).toBe('it');
        });

        it('rejects unsupported languages', () => {
            expect(normalizeLocale('ja')).toBeNull();
            expect(normalizeLocale('xx')).toBeNull();
            expect(normalizeLocale('')).toBeNull();
            expect(normalizeLocale(null)).toBeNull();
        });
    });

    describe('whisperLanguage()', () => {
        it('reduces pt-BR to pt, leaving the others untouched', () => {
            expect(whisperLanguage('pt-BR')).toBe('pt');
            expect(whisperLanguage('it')).toBe('it');
            expect(whisperLanguage('en')).toBe('en');
        });
    });

    describe('aiOutputDirective()', () => {
        it('nomina la lingua in inglese', () => {
            expect(aiOutputDirective('de')).toContain('German');
            expect(aiOutputDirective('pt-BR')).toContain('Brazilian Portuguese');
        });
    });
});
