
import { ANALYST_PROMPT } from '../../../src/bard/prompts';

describe('Analyst Prompt Reputation Extraction', () => {
    it('should explicitly mention the HOSTILITY RULE for factions', () => {
        const text = "Dummy text";
        const prompt = ANALYST_PROMPT("", "", text);

        expect(prompt).toContain('HOSTILITY RULE');
        expect(prompt).toContain('A faction member attacked the party');
        expect(prompt).toContain('NEGATIVE reputation_change');
    });

    it('should mention reputation drop in conflict resolution section', () => {
        const text = "Dummy text";
        const prompt = ANALYST_PROMPT("", "", text);

        expect(prompt).toContain('If a MEMBER of the faction attacks the party, reputation DROPS');
    });
});
