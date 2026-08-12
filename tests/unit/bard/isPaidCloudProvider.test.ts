
import { isPaidCloudProvider } from '../../../src/bard/agent/runtime';

describe('isPaidCloudProvider', () => {
    it('treats gemini as a paid cloud provider', () => {
        expect(isPaidCloudProvider('gemini')).toBe(true);
    });

    it('treats ollama-cloud as a paid cloud provider (hosted inference via API key)', () => {
        expect(isPaidCloudProvider('ollama-cloud')).toBe(true);
    });

    it('treats openai as a paid cloud provider (previously missing from the check)', () => {
        expect(isPaidCloudProvider('openai')).toBe(true);
    });

    it('does not treat local ollama as a paid cloud provider', () => {
        expect(isPaidCloudProvider('ollama')).toBe(false);
    });
});
