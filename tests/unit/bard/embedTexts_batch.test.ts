/**
 * How `embedTexts` reads a batch's response.
 *
 * It is the point at which a campaign's memory is lost without anyone
 * saying so: a missing vector is not an error, it is just a fragment that
 * search will never find again. Out of 253 fragments, eight vanished before
 * anybody counted the batches.
 */

const mockCreate = jest.fn();

jest.mock('../../../src/bard/ai/providerFactory', () => ({
    createProviderClient: () => ({ embeddings: { create: (...args: unknown[]) => mockCreate(...args) } }),
}));

jest.mock('../../../src/bard/ai/embeddings', () => ({
    resolveEmbedding: (jest.fn() as any).mockResolvedValue({
        provider: 'gemini',
        model: 'gemini-embedding-001',
        dimension: 3072,
        creds: { provider: 'gemini', source: 'tenant' },
    }),
}));

jest.mock('../../../src/monitor', () => ({ monitor: { logAIRequestWithCost: jest.fn() } }));

import { embedTexts } from '../../../src/bard/llm/embeddings';

const SCOPE = { guildId: 'gilda-batch' };

/** A recognizable vector, so we know which text produced which. */
const vectorFor = (n: number) => [n, n, n];

beforeEach(() => mockCreate.mockReset());

describe('reading a batch response', () => {
    it('does not lose the first element when the provider omits index 0', async () => {
        // It is literally what Gemini's compatible endpoint answers: Google's
        // protobuf JSON does not emit fields at their default value, and
        // 0 is the default of an integer. Taken literally, the first fragment of
        // every batch disappeared.
        mockCreate.mockResolvedValue({
            data: [
                { embedding: vectorFor(0) },
                { index: 1, embedding: vectorFor(1) },
                { index: 2, embedding: vectorFor(2) },
            ],
            usage: { prompt_tokens: 30 },
        });

        expect(await embedTexts(['a', 'b', 'c'], SCOPE)).toEqual([vectorFor(0), vectorFor(1), vectorFor(2)]);
    });

    it('keeps trusting index when it is present, even out of order', async () => {
        // The position in the array is the fallback, not the rule: if the provider
        // declares the order and declares it differently, it wins — attaching the
        // vector to the wrong fragment would be worse than losing it.
        mockCreate.mockResolvedValue({
            data: [
                { index: 2, embedding: vectorFor(2) },
                { index: 0, embedding: vectorFor(0) },
                { index: 1, embedding: vectorFor(1) },
            ],
            usage: { prompt_tokens: 30 },
        });

        expect(await embedTexts(['a', 'b', 'c'], SCOPE)).toEqual([vectorFor(0), vectorFor(1), vectorFor(2)]);
    });

    it('puts null where the provider returned nothing', async () => {
        // A declared hole is recoverable: the caller counts it and retries.
        mockCreate.mockResolvedValue({
            data: [{ index: 0, embedding: vectorFor(0) }, { index: 2, embedding: vectorFor(2) }],
            usage: { prompt_tokens: 20 },
        });

        expect(await embedTexts(['a', 'b', 'c'], SCOPE)).toEqual([vectorFor(0), null, vectorFor(2)]);
    });
});
