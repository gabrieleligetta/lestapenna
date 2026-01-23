import { db } from './client';

export const wipeDatabase = () => {
    // This function drops all tables and re-initializes.
    // Dangerous! 
    // Implementation: Drop everything.

    db.transaction(() => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
        for (const t of tables) {
            if (t.name !== 'sqlite_sequence') {
                db.prepare(`DROP TABLE IF EXISTS ${t.name}`).run();
            }
        }
    })();

    // We expect the caller to re-init via schema.initDatabase() if needed, 
    // but the original code might have inline re-creation or reliance on restart?
    // Original code:
    /*
     wipeDatabase() { ... drops ... creates ... }
    */
    // Since I moved creation to `schema.initDatabase()`, I should call it here?
    // Or just let the app crash/restart?
    // Let's import initDatabase and call it.

    const { initDatabase } = require('./schema'); // Late require to avoid circular dependency if any? 
    // Schema doesn't depend on maintenance.
    initDatabase();
};
