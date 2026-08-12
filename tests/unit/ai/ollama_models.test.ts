import { clearHealthCache, isOllamaAlive, listOllamaModels } from '../../../src/bard/ai/resolver';

/**
 * What is installed on the table's own Ollama node.
 *
 * No catalogue can know this — the models on someone's home PC are known only
 * by that PC — so `/api/tags` is the only truthful source, and the one call
 * answers both «is it up?» and «what is on it?».
 */

const originalFetch = global.fetch;

function answerWith(body: unknown, ok = true): void {
    global.fetch = jest.fn().mockResolvedValue({
        ok,
        json: async () => body,
    }) as unknown as typeof fetch;
}

describe('Ollama installed models', () => {
    beforeEach(() => {
        clearHealthCache();
    });

    afterAll(() => {
        global.fetch = originalFetch;
    });

    it('reads the tags the node reports', async () => {
        answerWith({ models: [{ name: 'qwen3:14b' }, { name: 'gemma3:12b' }] });

        await expect(listOllamaModels('http://pc:11434/v1')).resolves.toEqual(['qwen3:14b', 'gemma3:12b']);
    });

    it('asks the native API, not the OpenAI-compatible one', async () => {
        answerWith({ models: [] });

        await listOllamaModels('http://pc:11434/v1');

        expect(global.fetch).toHaveBeenCalledWith(
            'http://pc:11434/api/tags',
            expect.anything(),
        );
    });

    it('distinguishes a node that is up but empty from one that is unreachable', async () => {
        answerWith({ models: [] });
        await expect(listOllamaModels('http://empty:11434')).resolves.toEqual([]);

        clearHealthCache();
        global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
        await expect(listOllamaModels('http://off:11434')).resolves.toBeNull();
    });

    it('treats a non-2xx answer as unreachable', async () => {
        answerWith({}, false);
        await expect(listOllamaModels('http://broken:11434')).resolves.toBeNull();
    });

    it('ignores entries without a usable name', async () => {
        answerWith({ models: [{ name: 'qwen3:8b' }, {}, { name: 42 }] });

        await expect(listOllamaModels('http://pc:11434')).resolves.toEqual(['qwen3:8b']);
    });

    it('answers liveness from the same call rather than a second one', async () => {
        answerWith({ models: [{ name: 'qwen3:8b' }] });

        await listOllamaModels('http://pc:11434');
        await expect(isOllamaAlive('http://pc:11434')).resolves.toBe(true);

        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('caches the outcome so a settings page does not hammer a home PC', async () => {
        answerWith({ models: [{ name: 'qwen3:8b' }] });

        await listOllamaModels('http://pc:11434');
        await listOllamaModels('http://pc:11434');

        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
});
