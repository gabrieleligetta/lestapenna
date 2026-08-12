/**
 * Support for "what happened last session?": top-K by
 * semantic similarity can skip parts of a session that do not
 * resemble the question closely enough — askBard instead uses these two
 * helpers to retrieve the LAST session in full. See src/bard/rag/search.ts.
 */
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { sessionRepository } from '../../../src/db/repositories/SessionRepository';
import { knowledgeRepository } from '../../../src/db/repositories/KnowledgeRepository';
import { db } from '../../../src/db';

const GUILD = 'test_guild_last_session_recap';
let campaignId: number;

describe('getLatestSessionId + getFragmentsBySessionId', () => {
    beforeAll(() => {
        campaignId = campaignRepository.createCampaign(GUILD, 'Last Session Recap Campaign');
    });

    afterAll(() => {
        db.prepare('DELETE FROM knowledge_fragments WHERE campaign_id = ?').run(campaignId);
        db.prepare('DELETE FROM sessions WHERE campaign_id = ?').run(campaignId);
        db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId);
    });

    it('returns null when the campaign has no numbered sessions', () => {
        expect(sessionRepository.getLatestSessionId(campaignId)).toBeNull();
    });

    it('finds the session with the highest session_number, not the last inserted', () => {
        sessionRepository.createSession('sess-old', GUILD, campaignId);
        sessionRepository.setSessionNumber('sess-old', 5);

        sessionRepository.createSession('sess-newest', GUILD, campaignId);
        sessionRepository.setSessionNumber('sess-newest', 17);

        sessionRepository.createSession('sess-middle', GUILD, campaignId);
        sessionRepository.setSessionNumber('sess-middle', 10);

        expect(sessionRepository.getLatestSessionId(campaignId)).toBe('sess-newest');
    });

    it('getFragmentsBySessionId returns all of a session\'s chunks in insertion order', () => {
        const insert = db.prepare(`
            INSERT INTO knowledge_fragments (campaign_id, session_id, content, embedding_json, embedding_model, created_at)
            VALUES (?, ?, ?, '[]', 'test-model', ?)
        `);
        insert.run(campaignId, 'sess-newest', 'Chunk 1: inizio sessione', Date.now());
        insert.run(campaignId, 'sess-newest', 'Chunk 2: il ritorno di Piero', Date.now());
        insert.run(campaignId, 'sess-newest', 'Chunk 3: battaglia coi funghi', Date.now());
        // Noise: a fragment from ANOTHER session must not appear
        insert.run(campaignId, 'sess-old', 'Chunk di un\'altra sessione', Date.now());

        const fragments = knowledgeRepository.getFragmentsBySessionId('sess-newest');
        expect(fragments).toHaveLength(3);
        expect(fragments.map(f => f.content)).toEqual([
            'Chunk 1: inizio sessione',
            'Chunk 2: il ritorno di Piero',
            'Chunk 3: battaglia coi funghi',
        ]);
    });

    it('getFragmentsBySessionId returns an empty array for a session with no fragments', () => {
        expect(knowledgeRepository.getFragmentsBySessionId('sess-middle')).toHaveLength(0);
    });
});
