import { describe, expect, it } from '@jest/globals';
import {
    augmentNpcNamesFromAppositions,
    augmentNpcNamesFromKnownMentions
} from '../../../src/bard/entityExtraction';

describe('NPC apposition extraction', () => {
    it('adds a capitalized title that follows an existing NPC name', () => {
        const text = 'Dietro l altare apparve l Entità mangia-farfalle, la Dama Bianca. La creatura parlò.';

        expect(augmentNpcNamesFromAppositions(text, ['Entità mangia-farfalle'])).toEqual([
            'Entità mangia-farfalle',
            'Dama Bianca'
        ]);
    });

    it('adds a capitalized title that precedes an existing NPC name', () => {
        const text = 'La Dama Bianca, Entità mangia-farfalle, sollevò la mano.';

        expect(augmentNpcNamesFromAppositions(text, ['Entità mangia-farfalle'])).toEqual([
            'Entità mangia-farfalle',
            'Dama Bianca'
        ]);
    });

    it('ignores lowercase descriptive appositions', () => {
        const text = 'Trillo, il famiglio celestiale di Sephirot, si rannicchiò.';

        expect(augmentNpcNamesFromAppositions(text, ['Trillo'])).toEqual(['Trillo']);
    });
});

describe('NPC known mention extraction', () => {
    it('adds an existing NPC mentioned late in the text even when scout missed it', () => {
        const text = 'Una lunga esplorazione. '.repeat(1000) + 'Ma è la Dama Bianca? La dama vi sorride.';

        expect(augmentNpcNamesFromKnownMentions(text, ['Trillo'], [
            { name: 'Dama Bianca', aliases: null },
            { name: 'Mangiatrice di Farfalle', aliases: 'Entità mangia-farfalle' }
        ])).toEqual(['Trillo', 'Dama Bianca']);
    });

    it('does not add an NPC only because a partial word matches', () => {
        expect(augmentNpcNamesFromKnownMentions('La bianca pietra brillava.', [], [
            { name: 'Dama Bianca', aliases: null }
        ])).toEqual([]);
    });
});
