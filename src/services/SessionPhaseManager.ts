/**
 * Session Phase Manager - Tracks processing phases for crash recovery
 */

import { db } from '../db/client';

export type SessionPhase =
    | 'IDLE'
    | 'RECORDING'
    | 'TRANSCRIBING'
    | 'CORRECTING'
    | 'SUMMARIZING'
    | 'VALIDATING'
    | 'INGESTING'
    | 'SYNCING'
    | 'PUBLISHING'
    | 'DONE';

// Phases where transcripts are considered complete and valid
const POST_TRANSCRIPT_PHASES: SessionPhase[] = [
    'SUMMARIZING', 'VALIDATING', 'INGESTING', 'SYNCING', 'PUBLISHING', 'DONE'
];

// Phases that can be recovered
const RECOVERABLE_PHASES: SessionPhase[] = [
    'TRANSCRIBING', 'CORRECTING', 'SUMMARIZING', 'VALIDATING',
    'INGESTING', 'SYNCING', 'PUBLISHING'
];

export interface SessionPhaseInfo {
    sessionId: string;
    phase: SessionPhase;
    startedAt: number;
    guildId: string | null;
}

// All phases in order for progress display (matches actual execution order)
const ALL_PHASES: SessionPhase[] = [
    'RECORDING', 'TRANSCRIBING', 'CORRECTING', 'SUMMARIZING',
    'INGESTING', 'VALIDATING', 'SYNCING', 'PUBLISHING', 'DONE'
];

class SessionPhaseManagerImpl {
    /**
     * Updates the current processing phase for a session
     */
    setPhase(sessionId: string, phase: SessionPhase): void {
        db.prepare(`
            UPDATE sessions 
            SET processing_phase = ?, phase_started_at = ?
            WHERE session_id = ?
        `).run(phase, Date.now(), sessionId);

        this.printPhaseProgress(sessionId, phase);
    }

    /**
     * Prints a visual progress indicator for the current session
     */
    private printPhaseProgress(sessionId: string, currentPhase: SessionPhase): void {
        const shortId = sessionId.length > 20 ? sessionId.substring(0, 20) + '...' : sessionId;
        const phaseIndex = ALL_PHASES.indexOf(currentPhase);

        // Build progress bar
        const progressBar = ALL_PHASES.map((p, i) => {
            if (i < phaseIndex) return '✓';
            if (i === phaseIndex) return '▶';
            return '○';
        }).join(' ');

        console.log(`┌─────────────────────────────────────────────────────────────────────────────┐`);
        console.log(`│ 📍 ${shortId.padEnd(24)} │ ${currentPhase.padEnd(12)} │ ${progressBar.padEnd(30)} │`);
        console.log(`└─────────────────────────────────────────────────────────────────────────────┘`);
    }

    /**
     * Gets the current phase info for a session
     */
    getPhase(sessionId: string): SessionPhaseInfo | null {
        const row = db.prepare(`
            SELECT session_id, processing_phase, phase_started_at, guild_id
            FROM sessions WHERE session_id = ?
        `).get(sessionId) as {
            session_id: string;
            processing_phase: string;
            phase_started_at: number;
            guild_id: string | null;
        } | undefined;

        return row ? {
            sessionId: row.session_id,
            phase: row.processing_phase as SessionPhase,
            startedAt: row.phase_started_at || 0,
            guildId: row.guild_id
        } : null;
    }

    /**
     * Gets all sessions that are not IDLE or DONE (incomplete)
     */
    getIncompleteSessions(): SessionPhaseInfo[] {
        const rows = db.prepare(`
            SELECT session_id, processing_phase, phase_started_at, guild_id
            FROM sessions 
            WHERE processing_phase NOT IN ('IDLE', 'DONE', '')
            AND processing_phase IS NOT NULL
        `).all() as Array<{
            session_id: string;
            processing_phase: string;
            phase_started_at: number;
            guild_id: string | null;
        }>;

        return rows.map(row => ({
            sessionId: row.session_id,
            phase: row.processing_phase as SessionPhase,
            startedAt: row.phase_started_at || 0,
            guildId: row.guild_id
        }));
    }

    /**
     * Determines from which phase recovery should start
     * 
     * If crashed during transcription/correction: restart from transcription
     * If crashed after transcription: restart from summarization (transcripts are valid)
     */
    getRecoveryStartPhase(currentPhase: SessionPhase): 'TRANSCRIBING' | 'SUMMARIZING' | null {
        if (!this.isRecoverable(currentPhase)) {
            return null;
        }

        // If we crashed during transcription or correction, we need to redo transcription
        if (currentPhase === 'TRANSCRIBING' || currentPhase === 'CORRECTING') {
            return 'TRANSCRIBING';
        }

        // If we crashed after transcription is complete, just redo summary
        if (POST_TRANSCRIPT_PHASES.includes(currentPhase) && currentPhase !== 'DONE') {
            return 'SUMMARIZING';
        }

        return null;
    }

    /**
     * Checks if a phase is recoverable
     */
    isRecoverable(phase: SessionPhase): boolean {
        return RECOVERABLE_PHASES.includes(phase);
    }

    /**
     * Checks if transcripts are considered complete for a given phase
     */
    areTranscriptsComplete(phase: SessionPhase): boolean {
        return POST_TRANSCRIPT_PHASES.includes(phase);
    }

    /**
     * Marks a session as failed (for manual intervention)
     */
    markFailed(sessionId: string, reason: string): void {
        console.error(`[Phase] ❌ ${sessionId} FAILED: ${reason}`);
        // Keep the phase as-is for debugging, but log the failure
        // The session will be picked up by recovery on next restart
    }

    /**
     * Resets a session to IDLE state (e.g., after successful recovery or manual reset)
     */
    reset(sessionId: string): void {
        db.prepare(`
            UPDATE sessions 
            SET processing_phase = 'IDLE', phase_started_at = NULL
            WHERE session_id = ?
        `).run(sessionId);
        console.log(`[Phase] 🔄 ${sessionId}: Reset to IDLE`);
    }

    /**
     * Checks if a session is stuck (been in same phase for too long)
     * Default timeout: 2 hours
     */
    isStuck(sessionId: string, timeoutMs: number = 2 * 60 * 60 * 1000): boolean {
        const info = this.getPhase(sessionId);
        if (!info || info.phase === 'IDLE' || info.phase === 'DONE') {
            return false;
        }

        const elapsed = Date.now() - info.startedAt;
        return elapsed > timeoutMs;
    }
}

export const sessionPhaseManager = new SessionPhaseManagerImpl();
