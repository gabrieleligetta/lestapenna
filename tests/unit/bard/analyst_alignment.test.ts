
import { ANALYST_PROMPT } from '../../../src/bard/prompts';

describe('Analyst Prompt Alignment Extraction', () => {
    it('should extract alignment change when party acts heroically and lawfully', () => {
        const text = "Il gruppo decide di salvare i prigionieri rinunciando alla ricompensa, e consegna il bandito alle autorità locali rispettando la legge della città.";
        const prompt = ANALYST_PROMPT("", "", text);

        // We can't actually run the LLM here, but we can verify the prompt contains the instructions
        expect(prompt).toContain('ALLINEAMENTO PARTY');
        expect(prompt).toContain('BUONO');
        expect(prompt).toContain('LEGALE');
        expect(prompt).toContain('party_alignment_change');
    });

    it('should extract alignment change when party acts evilly and chaotically', () => {
        const text = "Il gruppo massacra i mercanti indifesi per rubare tutto il carico e poi dà fuoco al villaggio per puro divertimento.";
        const prompt = ANALYST_PROMPT("", "", text);

        expect(prompt).toContain('ALLINEAMENTO PARTY');
        expect(prompt).toContain('CATTIVO');
        expect(prompt).toContain('CAOTICO');
    });
});
