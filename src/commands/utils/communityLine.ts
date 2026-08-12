/**
 * The line that mentions the web app and `$dona`, appended to the start and the
 * end of a session.
 *
 * Modelled on `sessionCostLine`: it returns a line to concatenate, or an empty
 * string, and it **never fails the command**. Breaking `$listen` because a
 * reminder could not be composed would charge a fault of ours to the people
 * about to play.
 *
 * It is rate-limited to once every two weeks per server. A message that appears
 * at every session is not a reminder, it is noise — and noise about money, in
 * the middle of somebody's game, is the fastest way to make a free project feel
 * like a nagging one. Two weeks means a weekly table sees it roughly every
 * other session at worst.
 *
 * `COMMUNITY_NUDGES=false` switches it off entirely, leaving `$dona` for anyone
 * who goes looking.
 */

import { getGuildConfig, setGuildConfig } from '../../db';
import { config } from '../../config';
import { t } from '../../i18n';
import type { Locale } from '../../i18n';

/** How long between two nudges on the same server. */
export const NUDGE_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;

const CONFIG_KEY = 'community_nudge_at';

/**
 * The nudge line for this guild, already prefixed with a newline, or `''`.
 *
 * Records the timestamp as soon as it decides to show it, so two commands in the
 * same minute cannot both fire.
 */
export function communityLine(guildId: string, locale: Locale): string {
    try {
        if (!config.links.nudgesEnabled) return '';

        const url = config.links.webAppUrl;
        if (!url) return '';

        const last = Number(getGuildConfig(guildId, CONFIG_KEY) || 0);
        const now = Date.now();
        if (last && now - last < NUDGE_INTERVAL_MS) return '';

        setGuildConfig(guildId, CONFIG_KEY, String(now));
        return '\n\n' + t(locale, 'community.nudge', { url });
    } catch {
        // Same contract as sessionCostLine: a reminder is never worth an error.
        return '';
    }
}
