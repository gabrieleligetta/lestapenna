/**
 * Writes the OpenAPI document to web/openapi.json, from which the SPA
 * generates its types (`npm run api:types` in web/).
 *
 * Deliberately skips app.init(): the document only needs the metadata Nest
 * collects while building the module graph, and init() would fire
 * onModuleInit hooks (cookie plugin, Redis) that a codegen script has no
 * business starting.
 */
import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { createNestApp, buildOpenApiDocument } from '../api/main';

const OUTPUT = join(__dirname, '..', '..', 'web', 'openapi.json');

async function main(): Promise<void> {
    const app = await createNestApp();
    try {
        const document = buildOpenApiDocument(app);
        writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
        const routes = Object.keys(document.paths ?? {}).length;
        console.log(`OpenAPI document written to ${OUTPUT} (${routes} paths)`);
    } finally {
        await app.close();
    }
}

main()
    .then(() => {
        // webSession.store opens a Redis connection at import time and retries
        // forever, so the event loop never drains on a machine without Redis.
        // The document is already on disk: leave deliberately.
        process.exit(0);
    })
    .catch((err) => {
        console.error('Failed to generate the OpenAPI document:', err);
        process.exit(1);
    });
