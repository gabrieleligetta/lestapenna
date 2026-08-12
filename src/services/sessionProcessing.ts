import { monitor } from '../monitor';
import { enqueueSessionProcessing } from './recorder';
import { logger } from '../utils/logger';

const log = logger('SessionProcessing');

/**
 * Starts the mix/transcription at the end of a recording.
 *
 * There is no authorization left to grant: the software is free and the costs
 * fall on the user's provider account. The monitor stays on because it feeds
 * cost transparency (`ai_usage_log`), not billing.
 */
export function launchSessionProcessing(sessionId: string, guildId: string): void {
    monitor.startSession(sessionId);
    void enqueueSessionProcessing(sessionId, guildId).catch(async (error) => {
        await monitor.endSession();
        log.error(`Avvio processing fallito per la sessione ${sessionId}`, error);
    });
}
