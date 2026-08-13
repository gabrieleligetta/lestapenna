import 'dotenv/config';
import sodium from 'libsodium-wrappers';
import { db } from './db/client';
import { startWorker } from './workers';
import { logger } from './utils/logger';

const log = logger('WorkerBootstrap');

void (async () => {
    await sodium.ready;
    const workers = startWorker();
    log.info('Processing container ready');

    const shutdown = async (signal: string) => {
        log.info(`Received ${signal}, closing processing workers`);
        await workers.shutdown();
        db.close();
        process.exit(0);
    };
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));
})();
