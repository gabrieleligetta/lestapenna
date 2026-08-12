import {
    CHARACTER_BIO_WORD_BUDGET,
    CHARACTER_NARRATIVE_BIO_PROMPT,
} from '../../../src/bard/prompts';

describe('Character biography length budget', () => {
    const prompt = CHARACTER_NARRATIVE_BIO_PROMPT(
        'Sephirot',
        'A noble on the run.',
        '[TRAUMA] Betrayed by Helena.',
    );

    it('states the word budget instead of a character ceiling', () => {
        expect(prompt).toContain(
            `${CHARACTER_BIO_WORD_BUDGET.min}-${CHARACTER_BIO_WORD_BUDGET.max} words`,
        );
        expect(prompt).not.toContain('3500 characters');
    });

    it('keeps the budget short enough to stay a page, not a chapter', () => {
        // Roughly half of the old 3500-character ceiling: the sheet has to be
        // readable at a glance next to the rest of the character card.
        expect(CHARACTER_BIO_WORD_BUDGET.max).toBeLessThanOrEqual(280);
        expect(CHARACTER_BIO_WORD_BUDGET.min).toBeLessThan(CHARACTER_BIO_WORD_BUDGET.max);
    });

    it('tells the model to drop events rather than summarise them all', () => {
        expect(prompt).toContain('Keep only the turning points');
    });
});
