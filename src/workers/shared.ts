/**
 * Helpers shared between the Scriba (transcription) and Correction (AI correction) workers.
 * These blocks used to be copy-pasted between scriba.ts and correction.ts.
 */

import { getCampaignLocationById, getUserProfile } from '../db';
import { correctionQueue } from '../services/queue';

export interface RecordingContext {
    finalMacro: string | null;
    finalMicro: string | null;
    frozenCharName: string | null;
}

/**
 * "Freezes" the recording's context at save time: the campaign's current
 * location + the user's character name. These values are written onto the
 * PROCESSED recording so the summary uses the context as it was when the
 * recording was made, not the current one.
 */
export function resolveRecordingContext(
    campaignId: number | null | undefined,
    userId: string | null | undefined
): RecordingContext {
    let finalMacro: string | null = null;
    let finalMicro: string | null = null;
    let frozenCharName: string | null = null;

    if (campaignId) {
        const currentLoc = getCampaignLocationById(campaignId);
        finalMacro = currentLoc?.macro || null;
        finalMicro = currentLoc?.micro || null;

        if (userId) {
            const profile = getUserProfile(userId, campaignId);
            frozenCharName = profile.character_name || null;
        }
    }

    return { finalMacro, finalMicro, frozenCharName };
}

export interface CorrectionJobData {
    sessionId: string;
    fileName: string;
    segments: any[];
    campaignId: number | null | undefined;
    userId: string;
}

/**
 * Enqueues an AI correction job with the standard options (exponential retry,
 * unique jobId). Single source of truth for the correction queue's options.
 */
export function enqueueCorrection(payload: CorrectionJobData) {
    return correctionQueue.add('correction-job', payload, {
        jobId: `correct-${payload.fileName}-${Date.now()}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true
    });
}
