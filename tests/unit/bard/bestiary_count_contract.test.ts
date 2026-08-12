import { ANALYST_OUTPUT_SCHEMA } from '../../../src/bard/agent/outputSchemas';
import { normalizeMonsterList } from '../../../src/bard/monsterContract';
import { ANALYST_PROMPT } from '../../../src/bard/prompts';

describe('Bestiary AI contract without count', () => {
    it('does not expose count in the structured monster schema', () => {
        const monsterProperties = ANALYST_OUTPUT_SCHEMA.properties.monsters.items.properties;

        expect(monsterProperties).not.toHaveProperty('count');
        expect(ANALYST_OUTPUT_SCHEMA.properties.monsters.items.additionalProperties).toBe(false);
    });

    it('asks for one enemy type/name and explicitly rejects quantities', () => {
        const prompt = ANALYST_PROMPT('', '', 'Three goblins attack the party.');
        const monsterExample = prompt.slice(
            prompt.indexOf('"monsters":'),
            prompt.indexOf('// AI NOTICE:', prompt.indexOf('"monsters":')),
        );

        expect(monsterExample).not.toContain('"count"');
        expect(prompt).toContain('Record each type/name once and NEVER add a quantity/count field.');
    });

    it('strips the property from cached legacy analyst payloads', () => {
        expect(normalizeMonsterList([
            { name: 'Wolf', status: 'ALIVE', count: 'a pack', abilities: ['Bite'] },
        ])).toEqual([
            { name: 'Wolf', status: 'ALIVE', abilities: ['Bite'] },
        ]);
    });
});
