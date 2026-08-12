/**
 * Per-campaign embeddings.
 *
 * It is the pipeline choice that breaks in the worst way: changing model
 * corrupts nothing, it makes everything the campaign remembers **invisible**.
 * No error, no log, just a Bardo that no longer knows anything. Every case here
 * defends against a concrete way that amnesia could happen.
 */

import { wipeDatabase } from '../../../src/db/maintenance';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { tenantSecretsRepository } from '../../../src/db/repositories/TenantSecretsRepository';
import { tenantAiSettingsRepository } from '../../../src/db/repositories/TenantAiSettingsRepository';
import { db } from '../../../src/db';
import {
    EMBEDDING_MODELS,
    EmbeddingNotConfiguredError,
    campaignEmbeddingModel,
    estimateEmbeddingCostUsd,
    pinEmbeddingModel,
    resolveEmbedding,
    tenantOllamaUrl,
} from '../../../src/bard/ai/embeddings';
import { clearScopeCache, scopeForCampaign } from '../../../src/bard/ai/scope';

const GUILD = 'gilda-embedding';
const MASTER_KEY = Buffer.alloc(32, 5).toString('base64');

let campaignId: number;

beforeEach(() => {
    process.env.SECRETS_MASTER_KEY = MASTER_KEY;
    wipeDatabase();
    clearScopeCache();
    campaignId = campaignRepository.createCampaign(GUILD, 'Campagna');
});

afterAll(() => { delete process.env.SECRETS_MASTER_KEY; });

function putKey(secretKey: string) {
    tenantSecretsRepository.put({ scope: 'guild', scopeId: GUILD, secretKey }, 'una-chiave');
}

function withOwnPc(url = 'http://100.64.0.1:3001') {
    tenantAiSettingsRepository.put('guild', GUILD, {
        transcription: { engine: 'remote', remote: { url } },
    });
}

describe('choosing the model', () => {
    it('prefers the Ollama on the table\'s own PC, which is its own hardware', () => {
        withOwnPc();
        // Same host as the transcription server, Ollama's standard port.
        expect(tenantOllamaUrl({ guildId: GUILD })).toBe('http://100.64.0.1:11434/v1');
    });

    it('with no table PC there is no Ollama to use', () => {
        // In particular not the instance's: everyone's embeddings
        // on the operator's hardware are the same thing as whisper.cpp on the
        // server, removed for the same reason.
        expect(tenantOllamaUrl({ guildId: GUILD })).toBeNull();
    });

    it('with no PC it falls back to the table\'s key', async () => {
        putKey('openai.apiKey');
        const resolved = await resolveEmbedding(scopeForCampaign(campaignId), { probeOllama: false });

        expect(resolved.model).toBe('text-embedding-3-small');
        expect(resolved.provider).toBe('openai');
        expect(resolved.pinned).toBe(false);
    });

    it('uses Gemini when it is the only key the table has', async () => {
        putKey('gemini.apiKey');
        const resolved = await resolveEmbedding(scopeForCampaign(campaignId), { probeOllama: false });
        expect(resolved.provider).toBe('gemini');
    });

    it('with neither PC nor keys it says so, rather than guessing', async () => {
        await expect(resolveEmbedding(scopeForCampaign(campaignId), { probeOllama: false }))
            .rejects.toThrow(EmbeddingNotConfiguredError);
    });
});

describe('the pinned model does not change by itself', () => {
    it('an already indexed campaign stays on its own model', async () => {
        // The real case of the move to BYOK: the existing campaigns are on
        // nomic, and they have to keep working even after the guild has
        // added an OpenAI key.
        pinEmbeddingModel(campaignId, 'nomic-embed-text', 768);
        putKey('openai.apiKey');

        const resolved = await resolveEmbedding(scopeForCampaign(campaignId), { probeOllama: false });
        expect(resolved.model).toBe('nomic-embed-text');
        expect(resolved.pinned).toBe(true);
    });

    it('search filters on the same model it indexed with', () => {
        pinEmbeddingModel(campaignId, 'text-embedding-3-small', 1536);
        expect(campaignEmbeddingModel(campaignId)).toBe('text-embedding-3-small');
    });

    it('keeps a model we do not know, rather than replacing it', async () => {
        // A self-hoster may have indexed with a model of their own: forgetting it
        // would make their whole memory invisible.
        pinEmbeddingModel(campaignId, 'un-modello-mio', 512);
        const resolved = await resolveEmbedding(scopeForCampaign(campaignId), { probeOllama: false });

        expect(resolved.model).toBe('un-modello-mio');
        expect(resolved.dimension).toBe(512);
    });
});

describe('dimensioni', () => {
    it('every known model declares its own, and they differ', () => {
        // It is the reason they cannot be mixed: the cosine between different
        // spaces does not throw, it returns a meaningless number.
        expect(EMBEDDING_MODELS['nomic-embed-text'].dimension).toBe(768);
        expect(EMBEDDING_MODELS['text-embedding-3-small'].dimension).toBe(1536);
        expect(EMBEDDING_MODELS['gemini-embedding-001'].dimension).toBe(3072);
    });
});

describe('costo', () => {
    it('is zero on the table\'s own hardware', () => {
        expect(estimateEmbeddingCostUsd('nomic-embed-text', 10_000_000)).toBe(0);
    });

    it('stays under a cent for a real campaign', () => {
        // ~1850 fragments of 200 tokens ≈ 1.5M characters.
        const usd = estimateEmbeddingCostUsd('text-embedding-3-small', 1_500_000)!;
        expect(usd).toBeGreaterThan(0);
        expect(usd).toBeLessThan(0.01);
    });

    it('does not invent a price for a model it does not know', () => {
        expect(estimateEmbeddingCostUsd('un-modello-mio', 1_000_000)).toBeNull();
    });
});

describe('reindicizzazione', () => {
    it('does not touch the fragments until it has recomputed everything', () => {
        pinEmbeddingModel(campaignId, 'nomic-embed-text', 768);
        db.prepare(`
            INSERT INTO knowledge_fragments (campaign_id, content, embedding_json, embedding_model, vector_dimension)
            VALUES (?, ?, ?, ?, ?)
        `).run(campaignId, 'Helena entra nella taverna', '[0.1,0.2]', 'nomic-embed-text', 768);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { estimateReindex } = require('../../../src/bard/rag/reindex');
        const estimate = estimateReindex(campaignId, 'text-embedding-3-small');

        expect(estimate.fragments).toBe(1);
        expect(estimate.currentModel).toBe('nomic-embed-text');
        expect(estimate.estimatedUsd).toBeGreaterThanOrEqual(0);
        // The campaign is still on the previous model: the estimate changes nothing.
        expect(campaignEmbeddingModel(campaignId)).toBe('nomic-embed-text');
    });

    /**
     * A half-finished pass is the normal case, not the exceptional one: over
     * a few hundred fragments a single network error is enough for two or three
     * to stay on the old model, invisible to search. Recovery is the
     * only thing that picks them up, and for a while it did not work — the campaign
     * looked as if it were already on the new model and the second pass exited immediately.
     */
    describe('resuming a pass that stopped halfway', () => {
        function insertFragment(content: string, model: string): number {
            return Number(db.prepare(`
                INSERT INTO knowledge_fragments (campaign_id, content, embedding_json, embedding_model, vector_dimension)
                VALUES (?, ?, ?, ?, ?)
            `).run(campaignId, content, '[0.1,0.2]', model, model === 'nomic-embed-text' ? 768 : 1536).lastInsertRowid);
        }

        it('counts the ones left behind, not the ones already converted', () => {
            pinEmbeddingModel(campaignId, 'text-embedding-3-small', 1536);
            insertFragment('già convertito', 'text-embedding-3-small');
            insertFragment('già convertito anche questo', 'text-embedding-3-small');
            insertFragment('rimasto indietro', 'nomic-embed-text');

            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { estimateReindex } = require('../../../src/bard/rag/reindex');
            expect(estimateReindex(campaignId, 'text-embedding-3-small').fragments).toBe(1);
        });

        it('still finds them when the campaign is already on the new model', () => {
            pinEmbeddingModel(campaignId, 'text-embedding-3-small', 1536);
            insertFragment('già convertito', 'text-embedding-3-small');
            const rimasto = insertFragment('rimasto indietro', 'nomic-embed-text');

            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { knowledgeRepository } = require('../../../src/db');
            const daFare = knowledgeRepository.getFragmentsNotOnModel(campaignId, 'text-embedding-3-small');

            expect(daFare.map((f: { id: number }) => f.id)).toEqual([rimasto]);
        });

        it('still finds them when several passes scattered them across models', () => {
            pinEmbeddingModel(campaignId, 'gemini-embedding-001', 3072);
            insertFragment('a posto', 'gemini-embedding-001');
            insertFragment('fermo al primo modello', 'nomic-embed-text');
            insertFragment('fermo al secondo', 'text-embedding-3-small');

            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { knowledgeRepository } = require('../../../src/db');
            expect(knowledgeRepository.getFragmentsNotOnModel(campaignId, 'gemini-embedding-001')).toHaveLength(2);
        });
    });
});
