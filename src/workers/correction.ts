/**
 * Correction Worker Logic
 */

import { Job } from 'bullmq';
import { updateRecordingStatus } from '../db';
import { correctTranscription } from '../bard';
import { monitor } from '../monitor';
import { sessionPhaseManager } from '../services/SessionPhaseManager';
import { resolveRecordingContext } from './shared';
import { logger } from '../utils/logger';
import { runWithSessionScope } from '../bard/ai/scope';

const log = logger('Correttore');

const runCorrectionJob = async (job: Job) => {
    const { sessionId, fileName, segments, campaignId, userId } = job.data;
    const startJob = Date.now();
    const waitTime = startJob - job.timestamp;

    // Set session phase to CORRECTING (skipped when already in that phase: avoids a DB
    // write and a progress banner for EVERY corrected file)
    const currentPhase = sessionPhaseManager.getPhase(sessionId);
    if (currentPhase?.phase !== 'CORRECTING') {
        sessionPhaseManager.setPhase(sessionId, 'CORRECTING');
    }

    try {
        const aiResult = await correctTranscription(segments, campaignId);
        const correctedSegments = aiResult.segments;

        const jsonStr = JSON.stringify(correctedSegments);

        const { finalMacro, finalMicro, frozenCharName } = resolveRecordingContext(campaignId, userId);

        updateRecordingStatus(fileName, 'PROCESSED', jsonStr, null, finalMacro, finalMicro, [], frozenCharName);

        log.info(`Correzione completata per ${fileName}`, { sessionId });

        monitor.logJobProcessed(waitTime, job.attemptsMade);
        return { status: 'ok', segments: correctedSegments };

    } catch (e: any) {
        log.error(`Errore correzione ${fileName}: ${e.message}`, { sessionId });
        updateRecordingStatus(fileName, 'ERROR', null, `Correction Failed: ${e.message}`);
        monitor.logJobFailed();
        throw e;
    }
};

/** As with the Scriba: on the far side of Redis the scope has to be rebuilt. */
export const correctionProcessor = (job: Job) =>
    runWithSessionScope(job.data.sessionId, () => runCorrectionJob(job));
