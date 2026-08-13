import { db } from '../../../src/db';
import { recordingRepository } from '../../../src/db/repositories/RecordingRepository';
import { sessionPhaseManager } from '../../../src/services/SessionPhaseManager';

const SESSION_ID = 'test-done-session-with-failed-audio';

describe('session recovery state', () => {
    beforeEach(() => {
        db.prepare('DELETE FROM recordings WHERE session_id = ?').run(SESSION_ID);
        db.prepare('DELETE FROM sessions WHERE session_id = ?').run(SESSION_ID);
        db.prepare(`
            INSERT INTO sessions (session_id, processing_phase, phase_started_at)
            VALUES (?, 'DONE', ?)
        `).run(SESSION_ID, Date.now());
    });

    afterEach(() => {
        db.prepare('DELETE FROM recordings WHERE session_id = ?').run(SESSION_ID);
        db.prepare('DELETE FROM sessions WHERE session_id = ?').run(SESSION_ID);
    });

    function addRecording(filename: string, status: string, error: string | null = null): void {
        db.prepare(`
            INSERT INTO recordings (session_id, filename, filepath, timestamp, status, error_log)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(SESSION_ID, filename, `/tmp/${filename}`, Date.now(), status, error);
    }

    it('recovers a DONE session when one of its recordings is terminally failed', () => {
        addRecording('failed.flac', 'ERROR', 'remote unavailable');

        expect(sessionPhaseManager.getRecoveryStartPhase(SESSION_ID, 'DONE')).toBe('TRANSCRIBING');

        const recordings = recordingRepository.resetUnfinishedRecordings(SESSION_ID);
        expect(recordings).toEqual(expect.arrayContaining([
            expect.objectContaining({ filename: 'failed.flac', status: 'PENDING', error_log: null }),
        ]));
    });

    it('does not reopen a genuinely completed DONE session', () => {
        addRecording('complete.flac', 'PROCESSED');

        expect(sessionPhaseManager.getRecoveryStartPhase(SESSION_ID, 'DONE')).toBeNull();
    });
});
