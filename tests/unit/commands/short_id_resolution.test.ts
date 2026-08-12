/**
 * Command tokenization and short-id/name resolution with trailing tokens.
 *
 * Covers the "short id ignored when followed by a space + something else" bug:
 * the dispatcher split on a single space (double spaces → empty tokens,
 * newlines/tabs did not separate) and resolveEntity passed the whole trailing part
 * to parseShortId (an anchored regex → always null with extra tokens).
 */

import { parseCommandLine } from '../../../src/commands';
import { resolveEntityWithRest, resolveEntity, EntityCrudSpec } from '../../../src/commands/utils/entityCrud';

describe('parseCommandLine', () => {
    test('split base: comando + args', () => {
        expect(parseCommandLine('loot use pozione')).toEqual({
            commandName: 'loot', args: ['use', 'pozione'], rawArgs: 'use pozione'
        });
    });

    test('doppi spazi non generano token vuoti', () => {
        const r = parseCommandLine('loot  use   #ab12c');
        expect(r.commandName).toBe('loot');
        expect(r.args).toEqual(['use', '#ab12c']);
    });

    test('tab e newline separano i token', () => {
        const r = parseCommandLine('npc\tevents\n#a3f9c');
        expect(r.commandName).toBe('npc');
        expect(r.args).toEqual(['events', '#a3f9c']);
    });

    test('spazi in testa/coda ignorati; comando lowercased', () => {
        const r = parseCommandLine('  LOOT lista  ');
        expect(r.commandName).toBe('loot');
        expect(r.args).toEqual(['lista']);
    });

    test('rawArgs keeps the inner spacing', () => {
        const r = parseCommandLine('nota Testo  con   spazi');
        expect(r.rawArgs).toBe('Testo  con   spazi');
    });

    test('stringa vuota → commandName null', () => {
        expect(parseCommandLine('   ')).toEqual({ commandName: null, args: [], rawArgs: '' });
    });
});

describe('resolveEntityWithRest', () => {
    type Fake = { name: string; short_id: string };
    const items: Fake[] = [
        { name: 'Pozione di Cura', short_id: 'ab12c' },
        { name: 'Pozione 2', short_id: 'xy99z' },
        { name: 'Mario', short_id: 'qq111' }
    ];

    const spec = {
        getByShortId: (_cid: number, sid: string) => items.find(i => i.short_id === sid) || null,
        getByName: (_cid: number, name: string) => items.find(i => i.name.toLowerCase() === name.toLowerCase()) || null,
        name: (e: Fake) => e.name
    } as unknown as EntityCrudSpec<Fake>;

    test('a bare short-id (with and without #)', () => {
        expect(resolveEntityWithRest(spec, 1, '#ab12c').entity?.name).toBe('Pozione di Cura');
        expect(resolveEntityWithRest(spec, 1, 'ab12c').entity?.name).toBe('Pozione di Cura');
    });

    test('short-id followed by extra tokens: resolves and returns the rest (the bug)', () => {
        const r = resolveEntityWithRest(spec, 1, '#ab12c 3');
        expect(r.entity?.name).toBe('Pozione di Cura');
        expect(r.rest).toBe('3');

        const r2 = resolveEntityWithRest(spec, 1, 'ab12c qualcosa altro');
        expect(r2.entity?.name).toBe('Pozione di Cura');
        expect(r2.rest).toBe('qualcosa altro');
    });

    test('nome multi-parola intatto', () => {
        const r = resolveEntityWithRest(spec, 1, 'Pozione di Cura');
        expect(r.entity?.name).toBe('Pozione di Cura');
        expect(r.rest).toBe('');
    });

    test('an exact name ending in a number beats the peel (literal "Pozione 2")', () => {
        const r = resolveEntityWithRest(spec, 1, 'Pozione 2');
        expect(r.entity?.name).toBe('Pozione 2');
        expect(r.rest).toBe('');
    });

    test('nome + numero di pagina/quantità in coda', () => {
        const r = resolveEntityWithRest(spec, 1, 'Pozione di Cura 3');
        expect(r.entity?.name).toBe('Pozione di Cura');
        expect(r.rest).toBe('3');
    });

    test('a 5-char alphanumeric name is NOT swallowed by the short-id branch', () => {
        // "Mario" matches the short-id regex but does not exist as a short_id → name fallback
        const r = resolveEntityWithRest(spec, 1, 'Mario');
        expect(r.entity?.name).toBe('Mario');
    });

    test('non trovato → entity null', () => {
        expect(resolveEntityWithRest(spec, 1, 'Inesistente').entity).toBeNull();
        expect(resolveEntityWithRest(spec, 1, '').entity).toBeNull();
    });

    test('resolveEntity stays compatible (wrapper)', () => {
        expect(resolveEntity(spec, 1, '#ab12c')?.name).toBe('Pozione di Cura');
        expect(resolveEntity(spec, 1, '#ab12c 3')?.name).toBe('Pozione di Cura');
    });
});
