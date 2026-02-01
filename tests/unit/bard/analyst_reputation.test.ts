
import { ANALYST_PROMPT } from '../../../src/bard/prompts';

describe('Analyst Prompt Reputation Extraction', () => {
    it('should explicitly mention the HOSTILITY RULE for factions', () => {
        const text = "Dummy text";
        const prompt = ANALYST_PROMPT("", "", text);

        expect(prompt).toContain('REGOLA HOSTILITY');
        expect(prompt).toContain('Membro della fazione ha attaccato il party');
        expect(prompt).toContain('reputation_change NEGATIVO');
    });

    it('should mention reputation drop in conflict resolution section', () => {
        const text = "Dummy text";
        const prompt = ANALYST_PROMPT("", "", text);

        expect(prompt).toContain('Se un MEMBRO della fazione attacca il party, la reputazione CALA');
    });
});
