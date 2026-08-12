/**
 * Mining the raw recordings for what was actually said about a subject.
 *
 * The RAG holds cards and summaries — prose written *about* a session. The
 * sentence where somebody said what an NPC looks like survives only in the
 * transcript, which is why this lookup exists at all.
 */
import { createCampaign, deleteCampaign } from '../../../src/db';
import { db } from '../../../src/db/client';
import { recordingRepository } from '../../../src/db/repositories/RecordingRepository';

describe('transcript search', () => {
    let campaignId: number;

    beforeAll(() => {
        campaignId = createCampaign('Test Transcript Search', 'test-guild');

        db.prepare('INSERT INTO sessions (session_id, session_number, campaign_id) VALUES (?, ?, ?)')
            .run('sess-a', 11, campaignId);
        db.prepare('INSERT INTO sessions (session_id, session_number, campaign_id) VALUES (?, ?, ?)')
            .run('sess-b', 12, campaignId);

        const add = (sessionId: string, timestamp: number, text: string, present: string | null) => {
            db.prepare(`
                INSERT INTO recordings (session_id, filename, filepath, user_id, timestamp, status, transcription_text, present_npcs)
                VALUES (?, ?, ?, ?, ?, 'PROCESSED', ?, ?)
            `).run(sessionId, `${sessionId}-${timestamp}.flac`, '/tmp/x.flac', 'u1', timestamp, text, present);
        };

        add('sess-a', 1000, `${'x'.repeat(2000)} Astrid Foe entra: ha i capelli bianchi e un'armatura da Vergine di Ferro. ${'y'.repeat(2000)}`, 'Astrid Foe');
        add('sess-b', 2000, 'Parliamo del prezzo con la Signorina Faux.', 'Astrid Foe');
        add('sess-b', 3000, 'Nessuno di rilevante in questa scena.', null);
    });

    afterAll(() => {
        try { deleteCampaign(campaignId); } catch { /* already gone */ }
    });

    test('returns the words around the mention, not the head of a half-hour recording', () => {
        const passages = recordingRepository.searchTranscripts(campaignId, 'Astrid Foe', 5);
        const described = passages.find(passage => passage.session_number === 11)!;

        expect(described.excerpt).toContain('capelli bianchi');
        expect(described.excerpt.length).toBeLessThan(1000);
    });

    test('counts a scene where the subject was on stage without being named again', () => {
        const passages = recordingRepository.searchTranscripts(campaignId, 'Astrid Foe', 5);

        expect(passages.map(passage => passage.session_number).sort()).toEqual([11, 12]);
    });

    test('newest first: a description given last session outranks one from a year ago', () => {
        const passages = recordingRepository.searchTranscripts(campaignId, 'Astrid Foe', 5);

        expect(passages[0].timestamp).toBe(2000);
    });

    test('wildcards in a name are matched literally, not as a pattern', () => {
        // Without ESCAPE this returns every transcript in the campaign, and the
        // dossier gets built from scenes the subject was never in.
        expect(recordingRepository.searchTranscripts(campaignId, '%', 5)).toEqual([]);
        expect(recordingRepository.searchTranscripts(campaignId, '_', 5)).toEqual([]);
    });

    test('an empty term asks for nothing and gets nothing', () => {
        expect(recordingRepository.searchTranscripts(campaignId, '   ', 5)).toEqual([]);
    });

    test('another campaign\'s recordings are never returned', () => {
        const other = createCampaign('Other Table', 'other-guild');
        try {
            expect(recordingRepository.searchTranscripts(other, 'Astrid Foe', 5)).toEqual([]);
        } finally {
            try { deleteCampaign(other); } catch { /* already gone */ }
        }
    });
});
