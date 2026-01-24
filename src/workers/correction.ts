/**
 * Correction Worker Logic
 */

import { Job } from 'bullmq';
import {
    updateRecordingStatus,
    getCampaignLocationById,
    getUserProfile
} from '../db';
import { correctTranscription } from '../bard';
import { monitor } from '../monitor';
import { sessionPhaseManager } from '../services/SessionPhaseManager';

export const correctionProcessor = async (job: Job) => {
    const { sessionId, fileName, segments, campaignId, userId } = job.data;
    const startJob = Date.now();
    const waitTime = startJob - job.timestamp;

    // Set session phase to CORRECTING
    sessionPhaseManager.setPhase(sessionId, 'CORRECTING');

    try {
        const aiResult = await correctTranscription(segments, campaignId);
        const correctedSegments = aiResult.segments;

        const jsonStr = JSON.stringify(correctedSegments);

        let finalMacro = null;
        let finalMicro = null;
        if (campaignId) {
            const current = getCampaignLocationById(campaignId);
            finalMacro = current?.macro || null;
            finalMicro = current?.micro || null;
        }

        let frozenCharName = null;
        if (userId && campaignId) {
            const profile = getUserProfile(userId, campaignId);
            frozenCharName = profile.character_name || null;
        }

        updateRecordingStatus(fileName, 'PROCESSED', jsonStr, null, finalMacro, finalMicro, [], frozenCharName);

        console.log(`[Correttore] ✅ Correzione completata per ${fileName}`);

        monitor.logJobProcessed(waitTime, job.attemptsMade);
        return { status: 'ok', segments: correctedSegments };

    } catch (e: any) {
        console.error(`[Correttore] ❌ Errore correzione ${fileName}: ${e.message}`);
        updateRecordingStatus(fileName, 'ERROR', null, `Correction Failed: ${e.message}`);
        monitor.logJobFailed();
        throw e;
    }
};
