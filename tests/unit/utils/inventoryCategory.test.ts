import { guessInventoryCategory } from '../../../src/utils/inventoryCategory';

describe('guessInventoryCategory', () => {
    it('recognizes weapons', () => {
        expect(guessInventoryCategory('Spada lunga')).toBe('WEAPON');
        expect(guessInventoryCategory('Ascia da guerra')).toBe('WEAPON');
        expect(guessInventoryCategory('Arco lungo')).toBe('WEAPON');
    });

    it('recognizes consumables', () => {
        expect(guessInventoryCategory('Pozione di cura')).toBe('CONSUMABLE');
        expect(guessInventoryCategory('Antidoto al veleno')).toBe('CONSUMABLE');
    });

    it('recognizes armor', () => {
        expect(guessInventoryCategory('Scudo di ferro')).toBe('ARMOR');
        expect(guessInventoryCategory('Armatura di piastre')).toBe('ARMOR');
    });

    it('recognizes treasure', () => {
        expect(guessInventoryCategory('Gemma preziosa')).toBe('TREASURE');
        expect(guessInventoryCategory('Moneta antica')).toBe('TREASURE');
    });

    it('falls back to OTHER for unrecognized items', () => {
        expect(guessInventoryCategory('Ciondolo strano')).toBe('OTHER');
        expect(guessInventoryCategory('')).toBe('OTHER');
    });

    it('checks the description too when the name alone is ambiguous', () => {
        expect(guessInventoryCategory('Oggetto misterioso', 'una fiala di veleno mortale')).toBe('CONSUMABLE');
    });
});
