import type { Messages } from '../i18n/messages';
import type { AiProvider } from '../api/types';

/**
 * Readable names for the things the AI settings talk about.
 *
 * They used to be raw ids — `narrativeFilter`, `openai` — printed straight into
 * a select, which asks whoever is configuring the pipeline to already know it.
 * And they were duplicated: `PROVIDER_NAMES` lived unexported inside the guild
 * page, so the campaign page simply did without.
 */

/**
 * Providers the UI does not offer but may still have to name.
 *
 * A self-hoster can force them from `ai.config.json`, and if one shows up in an
 * effective configuration it needs a name rather than an empty cell. They are
 * not translated: they are trade names.
 */
const UNOFFERED_PROVIDER_NAMES: Record<string, string> = {
    anthropic: 'Anthropic',
    'ollama-cloud': 'Ollama Cloud',
};

export function providerName(t: Messages, provider: AiProvider | string): string {
    const offered = t.aiSettings.providerNames as Record<string, string | undefined>;
    return offered[provider] ?? UNOFFERED_PROVIDER_NAMES[provider] ?? provider;
}

/**
 * A phase's name.
 *
 * Falls back to the id: a phase added server-side and not yet translated should
 * still appear, unnamed, rather than as a blank row.
 */
export function phaseName(t: Messages, phase: string): string {
    const names = t.aiSettings.phaseNames as Record<string, string | undefined>;
    return names[phase] ?? phase;
}

/** Where the table goes to get or top up its own key. */
export const PROVIDER_CONSOLE: Record<string, string | null> = {
    openai: 'https://platform.openai.com/api-keys',
    gemini: 'https://aistudio.google.com/apikey',
    anthropic: 'https://console.anthropic.com/settings/keys',
    'ollama-cloud': 'https://ollama.com/settings/keys',
    ollama: null,
};

/**
 * A per-1M-token rate, trimmed of the noise.
 *
 * `0.05` and `2` should read as such, not as `0.0500` and `2.0000`: the point of
 * putting the figure here is a quick comparison between two lines, and trailing
 * zeros make two numbers look further apart than they are.
 */
export function formatRate(value: number): string {
    return value.toFixed(2).replace(/\.?0+$/, '') || '0';
}

/** A context window as people say it: 1M, 400k. */
export function formatContext(tokens: number): string {
    if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
    if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
    return String(tokens);
}
