/**
 * Sort and search parameters for list endpoints.
 *
 * The whitelist is the security boundary: `allowed` maps a public key to a
 * literal SQL fragment written here in the source. User input only ever selects
 * a key — it never reaches the query. An unknown key falls back silently rather
 * than 400ing, so a stale bookmark still renders a page.
 */

export interface SortSpec {
    /** Public key, echoed back so the UI can mark the active column. */
    key: string;
    direction: 'asc' | 'desc';
    /** Literal SQL, from the whitelist. Never interpolated user input. */
    orderBy: string;
}

export function parseSort(
    query: { sort?: string; dir?: string },
    allowed: Record<string, string>,
    fallbackKey: string,
): SortSpec {
    const key = query.sort && query.sort in allowed ? query.sort : fallbackKey;
    const direction = query.dir === 'desc' ? 'desc' : 'asc';
    const column = allowed[key] ?? allowed[fallbackKey];
    return { key, direction, orderBy: `${column} ${direction === 'desc' ? 'DESC' : 'ASC'}` };
}

/**
 * A free-text search term, trimmed and length-capped.
 *
 * Returned as a plain string for a parameterised LIKE — callers must bind it,
 * never concatenate.
 */
export function parseSearch(query: { q?: string }): string | null {
    const term = query.q?.trim();
    if (!term) return null;
    return term.slice(0, 100);
}

/** The LIKE pattern for a search term. Escapes the wildcards so a literal % is a literal %. */
export function likePattern(term: string): string {
    return `%${term.replace(/[%_]/g, (char) => `\\${char}`)}%`;
}

/** In-memory equivalent, for the small lists that are not worth SQL (characters, factions). */
export function sortRows<T extends Record<string, any>>(rows: T[], key: string, direction: 'asc' | 'desc'): T[] {
    const sign = direction === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
        const left = a[key];
        const right = b[key];
        if (left === right) return 0;
        if (left === null || left === undefined) return 1; // nulls last, both directions
        if (right === null || right === undefined) return -1;
        if (typeof left === 'number' && typeof right === 'number') return (left - right) * sign;
        return String(left).localeCompare(String(right)) * sign;
    });
}

export function filterRows<T extends Record<string, any>>(rows: T[], term: string | null, fields: string[]): T[] {
    if (!term) return rows;
    const needle = term.toLowerCase();
    return rows.filter((row) => fields.some((field) => String(row[field] ?? '').toLowerCase().includes(needle)));
}
