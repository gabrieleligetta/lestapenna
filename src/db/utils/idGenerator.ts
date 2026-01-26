import { db } from '../client';

/**
 * Generates a unique 5-character alphanumeric ID for an entity in a table.
 * 
 * @param table The database table name
 * @returns A unique 5-character string
 */
export function generateShortId(table: string): string {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // No 'i', 'l', 'o', '1', '0' for clarity
    let shortId = '';

    while (true) {
        shortId = '';
        for (let i = 0; i < 5; i++) {
            shortId += chars.charAt(Math.floor(Math.random() * chars.length));
        }

        // Check uniqueness
        const existing = db.prepare(`SELECT count(*) as count FROM ${table} WHERE short_id = ?`).get(shortId) as { count: number };
        if (existing.count === 0) {
            break;
        }
    }

    return shortId;
}
