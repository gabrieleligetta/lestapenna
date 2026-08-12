/**
 * A non-negotiable guardrail for askBard's tool-calling layer (the "Chiara Poggi"
 * case): the Bardo must NEVER use web search
 * or general/real-world knowledge to answer about entities absent from the campaign.
 * Here we verify structurally that (1) no exposed tool touches
 * the internet/general knowledge, and (2) the agentic prompt explicitly restates
 * the guardrail and is actually passed to the harness — a real
 * behavioural end-to-end test would need a real model, unsuited to CI.
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

jest.mock('../../../src/bard/config', () => ({
    EMBEDDING_MODEL_OLLAMA: 'nomic-embed-text',
    getChatClient: (jest.fn() as any).mockResolvedValue({ client: {}, model: 'gemini-3-flash-preview', provider: 'gemini' }),
}));

const mockRunAgent: any = jest.fn();
jest.mock('../../../src/bard/agent/runtime', () => ({
    runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

import { askBard } from '../../../src/bard/rag/search';
import { createBardoTools } from '../../../src/bard/agent/tools';
import { BARD_AGENTIC_PROMPT, RAG_QUERY_GENERATION_PROMPT } from '../../../src/bard/prompts';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { db } from '../../../src/db';

const GUILD = 'test_guild_askbard_guardrail';
let campaignId: number;

describe('askBard guardrail — no web search, no general knowledge', () => {
    beforeAll(() => {
        campaignId = campaignRepository.createCampaign(GUILD, 'Guardrail Campaign');
    });

    afterAll(() => {
        db.prepare('DELETE FROM ai_usage_log WHERE campaign_id = ?').run(campaignId);
        db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId);
    });

    beforeEach(() => {
        mockGenerateJson.mockReset();
        mockRunAgent.mockReset();
    });

    it('no tool exposed to the Bard touches the internet or general knowledge', () => {
        const tools = createBardoTools(campaignId);
        const names = tools.map(t => t.name);

        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
            expect(name.toLowerCase()).not.toMatch(/web|internet|browse|google|search_online|external/);
        }
        // Lookups over the campaign's own records only (DB + internal historical RAG).
        expect(names).toEqual(expect.arrayContaining([
            'get_campaign_snapshot', 'find_entities', 'get_entity_history',
            'get_open_quests', 'get_npc_dossier', 'resolve_entity',
            'search_historical_rag', 'get_last_session_recap'
        ]));
    });

    it('the agentic prompt states the no-invention/no-web guardrail explicitly', () => {
        const prompt = BARD_AGENTIC_PROMPT('atmosfera', '', 'contesto');
        expect(prompt).toMatch(/NEVER use general\/real-world knowledge/i);
        expect(prompt).toMatch(/no web search capability/i);
        expect(prompt).toMatch(/you don't know this character\/place\/thing/i);
    });

    it('askBard passes the guardrail into the agentic harness actual systemPrompt', async () => {
        mockGenerateJson.mockResolvedValue({
            content: '', parsed: { queries: ['chiara poggi'], wantsLastSessionRecap: false },
            provider: 'gemini', model: 'gemini-3-flash-preview',
            usage: { input: 10, output: 5, cached: 0 }, latencyMs: 1,
        });
        mockRunAgent.mockResolvedValue({
            output: { answer: "Non conosco questo nome nei registri della campagna." },
            transcript: [], turns: 1,
            usage: { input: 10, output: 5, inputChars: 0, outputChars: 0, cached: 0 },
        });

        const result = await askBard(campaignId, 'Chi è Chiara Poggi?', []);

        expect(result.answer).toContain('Non conosco questo nome');
        expect(mockRunAgent).toHaveBeenCalledTimes(1);
        const callArgs: any = mockRunAgent.mock.calls[0][0];
        expect(callArgs.systemPrompt).toMatch(/NEVER use general\/real-world knowledge/i);
        expect(callArgs.tools.map((t: any) => t.name)).toContain('get_npc_dossier');
    });

    /**
     * The second half of the same guardrail, and the one that failed in
     * production. The "Chiara Poggi" case is a name the campaign never mentions;
     * this is a subject it mentions constantly while never describing her face.
     * Asked what Astrid Foe looks like, the Bard returned a tiefling with ram
     * horns, gold eyes and a scar — none of it in any record. Plenty of material
     * *about* her had been retrieved, which is exactly what made the answer feel
     * grounded to a model with one free-text field to fill.
     */
    describe('a question the records cannot answer', () => {
        it('gives the model somewhere to put "not recorded" instead of a description', () => {
            const prompt = BARD_AGENTIC_PROMPT('atmosfera', '', 'contesto');

            expect(prompt).toMatch(/"grounded"/);
            expect(prompt).toMatch(/"missing"/);
            expect(prompt).toMatch(/is not material about every aspect/i);
        });

        it('keeps the persona away from the facts', () => {
            const prompt = BARD_AGENTIC_PROMPT('You are a cheerful, slightly tipsy bard.', '', 'contesto');

            // The voice may stay; what it is allowed to do is now bounded, and
            // bounded in the first line rather than in the middle of a list.
            expect(prompt).toContain('You are a cheerful, slightly tipsy bard.');
            expect(prompt).toMatch(/VOICE APPLIES TO WORDING ONLY/i);
        });

        it('reports the gap back to the caller rather than swallowing it', async () => {
            mockGenerateJson.mockResolvedValue({
                content: '', parsed: { queries: ['Astrid Foe aspetto capelli volto'], wantsLastSessionRecap: false },
                provider: 'gemini', model: 'gemini-3-flash-preview',
                usage: { input: 10, output: 5, cached: 0 }, latencyMs: 1,
            });
            mockRunAgent.mockResolvedValue({
                output: {
                    answer: 'I registri non descrivono il suo aspetto fisico.',
                    grounded: false,
                    missing: ['aspetto fisico', '   ', 42],
                },
                transcript: [], turns: 1,
                usage: { input: 10, output: 5, inputChars: 0, outputChars: 0, cached: 0 },
            });

            const result = await askBard(campaignId, 'Mi descrivi fisicamente Astrid Foe?', []);

            expect(result.grounded).toBe(false);
            expect(result.missing).toEqual(['aspetto fisico']);
        });

        it('does not claim groundedness the model never declared', async () => {
            mockGenerateJson.mockResolvedValue({
                content: '', parsed: { queries: ['x'], wantsLastSessionRecap: false },
                provider: 'gemini', model: 'gemini-3-flash-preview',
                usage: { input: 10, output: 5, cached: 0 }, latencyMs: 1,
            });
            mockRunAgent.mockResolvedValue({
                output: { answer: 'Una risposta qualunque.' },
                transcript: [], turns: 1,
                usage: { input: 10, output: 5, inputChars: 0, outputChars: 0, cached: 0 },
            });

            const result = await askBard(campaignId, 'Qualcosa?', []);

            expect(result.grounded).toBeNull();
            expect(result.missing).toEqual([]);
        });

        it('asks the retriever for the attribute, not only for the name', () => {
            // "Astrid Foe" alone retrieves every scene she was in, none of which
            // may describe her — an empty context that reads as a full one.
            const prompt = RAG_QUERY_GENERATION_PROMPT('', 'mi descrivi fisicamente Astrid Foe?');

            expect(prompt).toMatch(/ATTRIBUTE/);
            expect(prompt).toMatch(/what they look like/i);
        });
    });
});
