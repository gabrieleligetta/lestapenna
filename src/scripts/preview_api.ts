/**
 * Standalone API-only preview entry point (no Discord bot). Used by the local
 * preview so the SPA can talk to the NestJS API without logging the production
 * bot into Discord a second time. Run via nodemon for hot reload:
 *
 *   nodemon --watch src --exec ts-node src/scripts/preview_api.ts
 *
 * Set WEB_STANDALONE_PREVIEW=true so guild filtering uses the isolated preview
 * DB instead of the live Discord client (see me.controller.ts).
 */
import { startApiServer } from '../api/main';

startApiServer().catch((err: unknown) => {
    console.error('[Preview API] Failed to start:', err);
    process.exit(1);
});