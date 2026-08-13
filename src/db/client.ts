import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const dataDir = path.join(__dirname, '..', '..', 'data'); // Adjusted for src/db/client.ts
// DB_PATH override (for tests/benchmarks on a prod snapshot without touching the working db).
// Default unchanged: data/dnd_bot.db
const dbPath = process.env.DB_PATH || path.join(dataDir, 'dnd_bot.db');

// Make sure the directory exists
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
// The gateway and the processing worker share this local database. WAL permits
// readers during writes; busy_timeout turns a short write collision into a
// bounded wait instead of a user-visible SQLITE_BUSY failure.
db.pragma(`busy_timeout = ${Number.parseInt(process.env.SQLITE_BUSY_TIMEOUT_MS || '10000', 10) || 10000}`);
// better-sqlite3 does NOT enable foreign keys by default: without this pragma every
// ON DELETE CASCADE/SET NULL in the schema is ignored, and deleting a campaign
// would leave orphans in npc_dossier, knowledge_fragments, history, etc.
db.pragma('foreign_keys = ON');
