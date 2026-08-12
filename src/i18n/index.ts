/**
 * i18n — the bot's localization layer.
 *
 * 6 supported locales (en, it, es, fr, de, pt-BR — the main TTRPG markets).
 * The language is per-guild: `language` key in ConfigRepository, defaulting to
 * the guild's Discord `preferredLocale`, falling back to English.
 *
 * - UI strings: `t(locale, key, params)` over the dictionaries in ./locales/
 *   (en.ts is the source of the types: every other language MUST have all keys).
 * - AI output: prompts stay in canonical English; the output language is imposed with
 *   `aiOutputDirective(locale)` appended to the prompt (never translate the prompts).
 */

import { configRepository } from '../db/repositories/ConfigRepository';
import { en } from './locales/en';
import { it } from './locales/it';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { de } from './locales/de';
import { ptBR } from './locales/pt-BR';

export type Locale = 'en' | 'it' | 'es' | 'fr' | 'de' | 'pt-BR';
export type MessageKey = keyof typeof en;

export const SUPPORTED_LOCALES: Locale[] = ['en', 'it', 'es', 'fr', 'de', 'pt-BR'];
export const DEFAULT_LOCALE: Locale = 'en';

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = {
    en, it, es, fr, de, 'pt-BR': ptBR,
};

/** Native name of the language (for $language and the UIs). */
export const LANGUAGE_NAMES: Record<Locale, string> = {
    en: 'English',
    it: 'Italiano',
    es: 'Español',
    fr: 'Français',
    de: 'Deutsch',
    'pt-BR': 'Português (Brasil)',
};

/** English name of the language (for AI directives: more reliable than the native one). */
const AI_LANGUAGE_NAMES: Record<Locale, string> = {
    en: 'English',
    it: 'Italian',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    'pt-BR': 'Brazilian Portuguese',
};

/**
 * Normalizes a language code (user input, or a Discord locale such as `en-US`,
 * `es-419`, `pt-BR`) onto one of the supported locales. Null when unmappable.
 */
export function normalizeLocale(input?: string | null): Locale | null {
    if (!input) return null;
    const raw = input.trim().replace('_', '-');
    const lower = raw.toLowerCase();

    if (lower === 'pt-br' || lower === 'pt') return 'pt-BR';

    const base = lower.split('-')[0];
    if ((SUPPORTED_LOCALES as string[]).includes(base)) return base as Locale;
    return null;
}

/**
 * Resolves a guild's language: explicit config → Discord preferredLocale →
 * English. `preferredLocale` must be passed by the caller when it has the Guild.
 */
export function getGuildLocale(guildId: string, preferredLocale?: string | null): Locale {
    try {
        const configured = normalizeLocale(configRepository.getGuildConfig(guildId, 'language'));
        if (configured) return configured;
    } catch {
        // DB not initialised (a test with a partial schema): language resolution
        // must never block the dispatch — fall through to the fallbacks.
    }
    // Backwards compatibility: legacy (pre-SaaS) guilds have always used the bot
    // in Italian — and the Discord preferredLocale is not reliable (non-Community
    // servers always report en-US). Legacy → it, BEFORE the preferredLocale.
    try {
        const { tenantRepository } = require('../db/repositories/TenantRepository');
        if (tenantRepository.isLegacy(guildId)) return 'it';
    } catch { /* config/DB non pronti: si prosegue coi fallback standard */ }
    return normalizeLocale(preferredLocale) ?? DEFAULT_LOCALE;
}

export function setGuildLocale(guildId: string, locale: Locale): void {
    configRepository.setGuildConfig(guildId, 'language', locale);
}

/** Translates a key, interpolating the `{name}` parameters. Falls back to English. */
export function t(locale: Locale, key: MessageKey, params?: Record<string, string | number>): string {
    const template = DICTIONARIES[locale]?.[key] ?? DICTIONARIES[DEFAULT_LOCALE][key];
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
        params[name] !== undefined ? String(params[name]) : match
    );
}

/** English name of the language, used to build AI instructions ("Italian", "German"…). */
export function aiLanguageName(locale: Locale): string {
    return AI_LANGUAGE_NAMES[locale];
}

/**
 * Directive appended to AI prompts to impose the output language.
 * In English and repeated: it is the form models follow most reliably.
 */
export function aiOutputDirective(locale: Locale): string {
    const name = AI_LANGUAGE_NAMES[locale];
    return `\n\nIMPORTANT: Write ALL user-facing output in ${name}. Every sentence of your answer must be in ${name}.`;
}

/**
 * The CAMPAIGN's language: the one spoken at the table, which governs
 * transcription and AI output (summaries, askBard). Distinct from the guild's
 * UI language: a table can play in Italian with the bot's interface in English.
 * Priority: campaigns.language → guild language → default.
 * Lazy require to avoid import cycles (backup.ts#resolveGuildId pattern).
 */
export function getCampaignLocale(campaignId: number): Locale {
    try {
        const { campaignRepository } = require('../db/repositories/CampaignRepository');
        const campaign = campaignRepository.getCampaignById(campaignId);
        if (!campaign) return DEFAULT_LOCALE;
        const own = normalizeLocale(campaign.language);
        if (own) return own;
        return campaign.guild_id ? getGuildLocale(campaign.guild_id) : DEFAULT_LOCALE;
    } catch {
        return DEFAULT_LOCALE;
    }
}

/** ISO language code for Whisper (e.g. 'it', 'en', 'pt'). */
export function whisperLanguage(locale: Locale): string {
    return locale === 'pt-BR' ? 'pt' : locale;
}

/** Locale BCP-47 per toLocaleDateString/toLocaleString. */
export function dateLocale(locale: Locale): string {
    const map: Record<Locale, string> = {
        en: 'en-GB', it: 'it-IT', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', 'pt-BR': 'pt-BR',
    };
    return map[locale];
}

/**
 * Localized year/era label (`year.*` keys). Single source reused by
 * narrative/story, timeline/date, timeline/year0 and the chronology view.
 * `undefined` → "not set".
 */
export function yearLabel(locale: Locale, year: number | undefined): string {
    if (year === undefined) return t(locale, 'year.notSet');
    if (year === 0) return t(locale, 'year.zero');
    return year > 0
        ? t(locale, 'year.after', { n: year })
        : t(locale, 'year.before', { n: Math.abs(year) });
}

/**
 * Single catalogue of the UI labels for the canonical enums (event_type of the
 * entity chronologies + world events). The VALUES stay canonical English codes
 * in the DB and in the AI schemas — only the displayed label is localized here.
 * Coverage is guaranteed by the type: every code maps to an `enum.*` key.
 */
const EVENT_TYPE_LABEL_KEYS: Record<string, MessageKey> = {
    // NPC
    ALLIANCE: 'enum.ALLIANCE', BETRAYAL: 'enum.BETRAYAL', DEATH: 'enum.DEATH',
    REVELATION: 'enum.REVELATION', STATUS_CHANGE: 'enum.STATUS_CHANGE',
    FIRST_APPEARANCE: 'enum.FIRST_APPEARANCE', COMBAT: 'enum.COMBAT',
    INTERACTION: 'enum.INTERACTION', ABILITY_REVEALED: 'enum.ABILITY_REVEALED',
    // Artefatti
    OBSERVATION: 'enum.OBSERVATION', ACTIVATION: 'enum.ACTIVATION', TRANSFER: 'enum.TRANSFER',
    DESTRUCTION: 'enum.DESTRUCTION', CURSE: 'enum.CURSE', CURSE_REVEAL: 'enum.CURSE_REVEAL',
    // Personaggi
    GROWTH: 'enum.GROWTH', TRAUMA: 'enum.TRAUMA', ACHIEVEMENT: 'enum.ACHIEVEMENT',
    GOAL_CHANGE: 'enum.GOAL_CHANGE', BACKGROUND: 'enum.BACKGROUND', RELATIONSHIP: 'enum.RELATIONSHIP',
    // Inventario
    LOOT: 'enum.LOOT', USE: 'enum.USE', TRADE: 'enum.TRADE', LOST: 'enum.LOST',
    // Quest
    PROGRESS: 'enum.PROGRESS', COMPLETE: 'enum.COMPLETE', FAIL: 'enum.FAIL',
    OPEN: 'enum.OPEN', CLOSED: 'enum.CLOSED',
    // Bestiario
    ENCOUNTER: 'enum.ENCOUNTER', KILL: 'enum.KILL',
    // Luoghi
    VISIT: 'enum.VISIT', DISCOVERY: 'enum.DISCOVERY',
    // Fazioni
    REPUTATION_CHANGE: 'enum.REPUTATION_CHANGE', MEMBER_JOIN: 'enum.MEMBER_JOIN',
    MEMBER_LEAVE: 'enum.MEMBER_LEAVE',
    // Generici
    NOTE: 'enum.NOTE', UPDATE: 'enum.UPDATE', MANUAL_UPDATE: 'enum.MANUAL_UPDATE',
    EVENT: 'enum.EVENT', RECONCILED: 'enum.RECONCILED',
    // World events (timeline)
    WAR: 'enum.WAR', POLITICS: 'enum.POLITICS', CALAMITY: 'enum.CALAMITY',
    SUPERNATURAL: 'enum.SUPERNATURAL', MYTH: 'enum.MYTH', RELIGION: 'enum.RELIGION',
    BIRTH: 'enum.BIRTH', CONSTRUCTION: 'enum.CONSTRUCTION', GENERIC: 'enum.GENERIC',
    DISASTER: 'enum.DISASTER',
    // Stati NPC
    ALIVE: 'enum.ALIVE', DEAD: 'enum.DEAD', MISSING: 'enum.MISSING',
    UNKNOWN: 'enum.UNKNOWN',
    // Faction reputation
    HOSTILE: 'enum.HOSTILE', DISTRUSTFUL: 'enum.DISTRUSTFUL', COLD: 'enum.COLD',
    NEUTRAL: 'enum.NEUTRAL', CORDIAL: 'enum.CORDIAL', FRIENDLY: 'enum.FRIENDLY',
    ALLIED: 'enum.ALLIED',
    // Faction types
    PARTY: 'enum.PARTY', GUILD: 'enum.GUILD', KINGDOM: 'enum.KINGDOM',
    CULT: 'enum.CULT', ORGANIZATION: 'enum.ORGANIZATION',
    // Faction statuses
    ACTIVE: 'enum.ACTIVE', DISBANDED: 'enum.DISBANDED', DESTROYED: 'enum.DESTROYED',
    // Faction affiliation roles
    LEADER: 'enum.LEADER', MEMBER: 'enum.MEMBER', ALLY: 'enum.ALLY',
    ENEMY: 'enum.ENEMY', CONTROLLED: 'enum.CONTROLLED',
    HQ: 'enum.HQ', PRESENCE: 'enum.PRESENCE', PRISONER: 'enum.PRISONER',
};

/** Localized label for a canonical event_type; the raw code as fallback. */
export function eventTypeLabel(locale: Locale, eventType: string): string {
    const key = EVENT_TYPE_LABEL_KEYS[eventType];
    return key ? t(locale, key) : eventType;
}
