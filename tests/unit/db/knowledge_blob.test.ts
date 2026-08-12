/**
 * Embeddings as a BLOB (raw Float32) on knowledge_fragments.
 *
 * Invariants:
 *  - insert writes the BLOB (4 bytes × dim) and the round trip preserves the values;
 *  - decodeFragmentVector copies the Buffer (no view over a misaligned pool).
 */

import { wipeDatabase } from '../../../src/db/maintenance';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { knowledgeRepository } from '../../../src/db/repositories/KnowledgeRepository';
import { decodeFragmentVector } from '../../../src/bard/rag/search';
import { db } from '../../../src/db';

const GUILD = 'test_knowledge_blob';
const DIM = 8;
let campaignId: number;

function makeVector(seed: number): number[] {
    return Array.from({ length: DIM }, (_, i) => Math.fround(seed + i * 0.25));
}

beforeAll(() => {
    wipeDatabase();
    campaignId = campaignRepository.createCampaign('Knowledge BLOB Campaign', GUILD);
});

describe('insertKnowledgeFragment writes the BLOB', () => {
    test('a 4×dim byte BLOB, identical Float32 roundtrip, JSON still there (dual-write)', () => {
        const vec = makeVector(1);
        knowledgeRepository.insertKnowledgeFragment(campaignId, 'sess-blob-1', 'contenuto', vec, 'nomic-embed-text');

        const row = db.prepare(
            `SELECT embedding, embedding_json FROM knowledge_fragments WHERE campaign_id = ? AND session_id = 'sess-blob-1'`
        ).get(campaignId) as { embedding: Buffer; embedding_json: string };

        expect(Buffer.isBuffer(row.embedding)).toBe(true);
        expect(row.embedding.length).toBe(4 * DIM);
        expect(JSON.parse(row.embedding_json)).toHaveLength(DIM);

        const decoded = decodeFragmentVector({ embedding_json: row.embedding_json, embedding: row.embedding })!;
        expect(Array.from(decoded)).toEqual(vec);
    });

    test('replaceSessionKnowledge writes the BLOB on every fragment', () => {
        knowledgeRepository.replaceSessionKnowledge('sess-blob-2', 'nomic-embed-text', [
            { campaignId, content: 'a', embedding: makeVector(2), startTimestamp: 0, macro: null, micro: null, npcs: [], entityRefs: [] },
            { campaignId, content: 'b', embedding: makeVector(3), startTimestamp: 0, macro: null, micro: null, npcs: [], entityRefs: [] }
        ]);
        const rows = db.prepare(
            `SELECT embedding FROM knowledge_fragments WHERE session_id = 'sess-blob-2'`
        ).all() as { embedding: Buffer }[];
        expect(rows).toHaveLength(2);
        for (const r of rows) expect(r.embedding.length).toBe(4 * DIM);
    });
});

describe('decodeFragmentVector', () => {
    test('decodes correctly even from a Buffer with an unaligned byteOffset', () => {
        const vec = makeVector(6);
        const raw = Buffer.from(Float32Array.from(vec).buffer);
        // Simulates better-sqlite3's pool: a Buffer with an odd offset inside a larger buffer
        const pool = Buffer.alloc(raw.length + 3);
        raw.copy(pool, 3);
        const unaligned = pool.subarray(3);
        expect(unaligned.byteOffset % 4).not.toBe(0);

        const decoded = decodeFragmentVector({ embedding_json: '[]', embedding: unaligned })!;
        expect(Array.from(decoded)).toEqual(vec);
    });

    test('falls back to embedding_json when the BLOB is missing', () => {
        const vec = makeVector(7);
        const decoded = decodeFragmentVector({ embedding_json: JSON.stringify(vec), embedding: null })!;
        expect(Array.from(decoded)).toEqual(vec);
    });
});
