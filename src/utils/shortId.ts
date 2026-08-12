/**
 * Parsing of entity short-ids (5 alphanumeric characters, optional # prefix),
 * e.g. `$npc #a3f9c`. Single source of truth for the regex: it used to be duplicated
 * across ~28 commands.
 */
export const SHORT_ID_RE = /^#?([a-z0-9]{5})$/i;

/** Returns the normalized short-id (lowercase, without #) or null if the argument is not one. */
export function parseShortId(arg: string | undefined | null): string | null {
    if (!arg) return null;
    const m = arg.trim().match(SHORT_ID_RE);
    return m ? m[1].toLowerCase() : null;
}
