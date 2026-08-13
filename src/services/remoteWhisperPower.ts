import axios from 'axios';
import { audioQueue, correctionQueue } from './queue';
import { currentAiScope } from '../bard/ai/ambientScope';
import { resolveTranscription } from '../bard/ai/transcription';
import type { AiScope } from '../bard/ai/types';

/**
 * Whether anything is still waiting to be transcribed or corrected.
 *
 * Exported because the manual shutdown button needs the same guard the
 * automatic one has: switching the machine off with audio still in the queue
 * loses the session, and a button that does it silently is worse than one that
 * refuses and says why.
 */
export async function hasPendingTranscriptionWork(): Promise<boolean> {
    const [audioCounts, correctionCounts] = await Promise.all([
        audioQueue.getJobCounts('waiting', 'delayed', 'active'),
        correctionQueue.getJobCounts('waiting', 'delayed', 'active'),
    ]);

    const audioBusy = (audioCounts.waiting || 0) + (audioCounts.delayed || 0) + (audioCounts.active || 0);
    const correctionBusy = (correctionCounts.waiting || 0) + (correctionCounts.delayed || 0) + (correctionCounts.active || 0);

    return audioBusy + correctionBusy > 0;
}

/**
 * Asks the table's PC to shut down at the end of a session.
 *
 * ⚠️ **Only that table's PC.** It used to read the single address configured in
 * the environment: on an instance with several tables it would have switched off
 * somebody else's computer, at the end of a session that was not theirs. Without
 * a scope it reaches nobody.
 *
 * It is opt-in per table: switching off a home computer is an effect that has to
 * be asked for, not inferred.
 */
export async function requestRemoteWhisperShutdown(sessionId: string, scope?: AiScope): Promise<void> {
    const resolved = scope ?? currentAiScope();
    if (!resolved) return;

    const transcription = resolveTranscription(resolved);
    if (transcription.engine !== 'remote') return;

    const remote = transcription.remote;
    if (!remote.shutdownEnabled) return;

    try {
        if (await hasPendingTranscriptionWork()) {
            console.log('[RemotePower] Shutdown remoto saltato: ci sono ancora job audio/correzione in coda.');
            return;
        }

        console.log(`[RemotePower] Richiesta spegnimento PC del tavolo dopo sessione ${sessionId}...`);
        await axios.post(
            `${remote.url}/shutdown`,
            { shutdown: true, delaySeconds: remote.shutdownDelaySeconds, reason: `session_done:${sessionId}` },
            {
                timeout: 10_000,
                headers: { 'Content-Type': 'application/json', ...remote.shutdownHeaders },
            },
        );

        console.log(`[RemotePower] Shutdown remoto programmato tra ${remote.shutdownDelaySeconds}s.`);
    } catch (err: any) {
        console.warn(`[RemotePower] Shutdown remoto non riuscito: ${err.message}`);
    }
}
