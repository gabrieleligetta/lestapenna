/**
 * $ask goes through no admission gate, and Monitor's cost logging is a no-op
 * without an active recording session (askBard almost always runs OUTSIDE
 * a session). askBard now tracks the cost of EVERY exchange directly in
 * ai_usage_log (session_id 'ASK'), independently of Monitor. Here we mock the
 * LLM level (generateJson for the query generation) and the agentic harness (runAgent for the
 * final answer, which now goes through the bounded tool-calling layer) — the DB and the
 * repositories are real, so real persistence is verified.
 */
import { jest } from '@jest/globals';

const mockGenerateJson: any = jest.fn();
jest.mock('../../../src/bard/llm/generate', () => ({
    generateJson: (...args: unknown[]) => mockGenerateJson(...args),
}));

jest.mock('../../../src/bard/llm/embeddings', () => ({
    embedText: (jest.fn() as any).mockResolvedValue(new Array(768).fill(0.01)),
    embedTexts: (jest.fn() as any).mockResolvedValue([]),
}));

const mockGetChatClient: any = jest.fn();
// The real model used in production for the Chat/RAG phase — not a
// random model, so the test stays representative.
mockGetChatClient.mockResolvedValue({ client: {}, model: 'gemini-3-flash-preview', provider: 'gemini' });
jest.mock('../../../src/bard/config', () => ({
    EMBEDDING_MODEL_OLLAMA: 'nomic-embed-text',
    getChatClient: (...args: unknown[]) => mockGetChatClient(...args),
}));

const mockRunAgent: any = jest.fn();
jest.mock('../../../src/bard/agent/runtime', () => ({
    runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

jest.mock('../../../src/services/aiCostTransparency', () => {
    const actual = jest.requireActual('../../../src/services/aiCostTransparency') as Record<string, unknown>;
    return {
        ...actual,
        getUsdEurRate: (jest.fn() as any).mockResolvedValue({
            source: 'ECB',
            usdPerEur: 1.1,
            rateDate: '2026-07-27',
            fetchedAt: 1_775_000_000_000,
        }),
    };
});

import { askBard } from '../../../src/bard/rag/search';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { aiUsageRepository } from '../../../src/db/repositories/AiUsageRepository';
import { db } from '../../../src/db';

const GUILD = 'test_guild_askbard_cost';
let campaignId: number;

function mockQueryGenResult(overrides: Partial<{ parsed: any; input: number; output: number; cached: number; provider: string; model: string }>) {
    return {
        content: '',
        parsed: overrides.parsed,
        // The real production model for Chat/RAG (gemini-3-flash-preview), not a
        // random one — so the costs computed here are representative.
        provider: overrides.provider ?? 'gemini',
        model: overrides.model ?? 'gemini-3-flash-preview',
        usage: { input: overrides.input ?? 0, output: overrides.output ?? 0, cached: overrides.cached ?? 0 },
        latencyMs: 42,
    };
}

function mockAgentResult(answer: string, input: number, output: number) {
    return {
        output: { answer },
        transcript: [],
        turns: 1,
        usage: { input, output, inputChars: 0, outputChars: answer.length, cached: 0 },
    };
}

describe('askBard cost tracking', () => {
    beforeAll(() => {
        campaignId = campaignRepository.createCampaign(GUILD, 'AskBard Cost Campaign');
    });

    afterAll(() => {
        db.prepare('DELETE FROM ai_usage_log WHERE campaign_id = ?').run(campaignId);
        db.prepare('DELETE FROM usage_tracking WHERE guild_id = ?').run(GUILD);
        db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId);
    });

    beforeEach(() => {
        mockGenerateJson.mockReset();
        mockRunAgent.mockReset();
        mockGetChatClient.mockReset();
        mockGetChatClient.mockResolvedValue({ client: {}, model: 'gemini-3-flash-preview', provider: 'gemini' });
        db.prepare('DELETE FROM ai_usage_log WHERE campaign_id = ?').run(campaignId);
    });

    it('records and persists the cost of an exchange immediately, with no active Monitor session', async () => {
        mockGenerateJson.mockResolvedValue(mockQueryGenResult({
            parsed: { queries: ['test query'], wantsLastSessionRecap: false },
            input: 1000, output: 100,
        }));
        mockRunAgent.mockResolvedValue(mockAgentResult('Il Bardo risponde con saggezza.', 2000, 500));

        const result = await askBard(campaignId, 'Chi è il misterioso straniero?', []);

        expect(result.answer).toBe('Il Bardo risponde con saggezza.');
        // gemini-3-flash-preview (src/monitor/costs.ts): input $0.50/1M, output $3.00/1M
        // query-gen: 1000*0.50/1e6 + 100*3.00/1e6 = 0.0005 + 0.0003 = 0.0008
        // answer:    2000*0.50/1e6 + 500*3.00/1e6 = 0.0010 + 0.0015 = 0.0025
        expect(result.costUsd).toBeCloseTo(0.0033, 6);

        const rows = aiUsageRepository.getSessionEntries('ASK');
        const ourRows = rows.filter(r => r.campaign_id === campaignId);
        expect(ourRows).toHaveLength(2);
        expect(ourRows.map(r => r.phase).sort()).toEqual(['ask_answer', 'ask_query_generation']);
        expect(ourRows.every(r => r.guild_id === GUILD)).toBe(true);
        expect(ourRows.every(r => r.exchange_rate_source === 'ECB')).toBe(true);
        expect(ourRows.reduce((sum, row) => sum + (row.cost_eur || 0), 0))
            .toBeCloseTo(0.0033 / 1.1, 6);
        const aggregate = db.prepare(
            `SELECT ai_cost_usd, ai_cost_eur FROM usage_tracking
             WHERE guild_id = ? AND month = strftime('%Y-%m', 'now')`,
        ).get(GUILD) as { ai_cost_usd: number; ai_cost_eur: number };
        expect(aggregate.ai_cost_usd).toBeCloseTo(0.0033, 6);
        expect(aggregate.ai_cost_eur).toBeCloseTo(0.0033 / 1.1, 6);
    });

    it('records no cost when the provider configured for the chat phase is local (ollama, free)', async () => {
        mockGenerateJson.mockResolvedValue(mockQueryGenResult({
            parsed: { queries: [], wantsLastSessionRecap: false },
            provider: 'ollama', model: 'llama3',
        }));
        mockGetChatClient.mockResolvedValue({ client: {}, model: 'llama3', provider: 'ollama' });
        mockRunAgent.mockResolvedValue(mockAgentResult('Risposta locale.', 100, 20));

        const result = await askBard(campaignId, 'Domanda qualsiasi', []);

        expect(result.costUsd).toBe(0);
        const rows = aiUsageRepository.getSessionEntries('ASK').filter(r => r.campaign_id === campaignId);
        expect(rows).toHaveLength(0);
    });

    it('still records the query-generation cost even when the final answer fails', async () => {
        mockGenerateJson.mockResolvedValue(mockQueryGenResult({
            parsed: { queries: ['q'], wantsLastSessionRecap: false },
            input: 500, output: 50,
        }));
        // askBard uses withRetry (3 attempts, exponential backoff) on the agentic
        // harness of the final answer: a constant rejection takes longer than
        // jest's default timeout.
        mockRunAgent.mockRejectedValue(new Error('provider down'));

        const result = await askBard(campaignId, 'Altra domanda', []);

        expect(result.answer.length).toBeGreaterThan(0); // messaggio di fallback, non vuoto
        const rows = aiUsageRepository.getSessionEntries('ASK').filter(r => r.campaign_id === campaignId);
        expect(rows).toHaveLength(1);
        expect(rows[0].phase).toBe('ask_query_generation');
        expect(result.costUsd).toBeGreaterThan(0);
    }, 15000);
});
