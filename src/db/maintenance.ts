import { db } from './client';
import { initDatabase } from './schema';

/**
 * Drops every table and recreates the schema from scratch.
 *
 * Destructive: it serves the tests and starting over from a clean database, not
 * production. `sqlite_sequence` is managed by SQLite and must not be touched.
 */
export const wipeDatabase = () => {
    if (process.env.NODE_ENV !== 'test') {
        throw new Error('wipeDatabase is test-only and cannot run outside NODE_ENV=test');
    }

    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
        const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table'",
        ).all() as { name: string }[];
        for (const t of tables) {
            if (t.name !== 'sqlite_sequence') {
                db.prepare(`DROP TABLE IF EXISTS "${t.name}"`).run();
            }
        }
    })();

    initDatabase();
    db.pragma('foreign_keys = ON');
};
