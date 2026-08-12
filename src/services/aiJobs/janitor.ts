import cron from 'node-cron';
import { aiJobRepository } from '../../db/repositories/AiJobRepository';
import { EntityMediaStorage } from '../entityMediaStorage';
import { logger } from '../../utils/logger';

const log = logger('AiJobJanitor');

/** After the storage janitor at 04:00, before the model catalogue at 04:30. */
const SWEEP_SCHEDULE = '15 4 * * *';

/** Long enough after boot that nothing competes with it for a cold start. */
const STARTUP_DELAY_MS = 90_000;

/**
 * How long a finished job stays in the register.
 *
 * The register is a log, not an archive, and `params_json` holds what people
 * typed. Ninety days is long enough to answer «what did that cost» and short
 * enough that nobody's prompts accumulate forever.
 */
const KEEP_FINISHED_MS = 90 * 24 * 60 * 60 * 1000;

let registered = false;

export function registerAiJobSweeper(): void {
    if (registered) return;
    registered = true;

    setTimeout(() => {
        void sweepAiJobs().catch(error => log.error('Startup sweep failed', error as Error));
    }, STARTUP_DELAY_MS).unref?.();

    cron.schedule(SWEEP_SCHEDULE, () => {
        void sweepAiJobs().catch(error => log.error('Scheduled sweep failed', error as Error));
    });
}

/**
 * Throws away results nobody claimed, and keeps their record.
 *
 * The row survives its artifact on purpose: «you paid for this picture and never
 * took it» is information a table is entitled to, and deleting the evidence
 * along with the bytes would make the register lie by omission.
 */
export async function sweepAiJobs(now = Date.now()): Promise<{ expired: number; deleted: number }> {
    const storage = new EntityMediaStorage();
    const due = aiJobRepository.listExpired(now);
    let deleted = 0;

    for (const job of due) {
        for (const key of [job.result_original_key, job.result_display_key]) {
            if (!key) continue;
            try {
                await storage.delete(key);
                deleted += 1;
            } catch (error) {
                // Leave the row alone if its objects cannot go: better a second
                // attempt tomorrow than a record pointing at bytes still there.
                log.warn(`Could not delete ${key}: ${(error as Error).message}`);
            }
        }
        aiJobRepository.markExpired(job.id);
    }

    const purged = aiJobRepository.deleteFinishedBefore(now - KEEP_FINISHED_MS);
    if (due.length > 0 || purged > 0) {
        log.info(`Swept ${due.length} unclaimed result(s), removed ${purged} old record(s)`);
    }
    return { expired: due.length, deleted };
}
