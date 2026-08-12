
import { reassessNpcMoralWeights } from '../../../src/bard/moralReassessment';
import { getAnalystClient } from '../../../src/bard/config';

jest.mock('../../../src/bard/config', () => ({
    ...jest.requireActual('../../../src/bard/config'),
    getAnalystClient: jest.fn()
}));

describe('reassessNpcMoralWeights', () => {
    let mockCreate: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.DISABLE_MORAL_REASSESSMENT;
        mockCreate = jest.fn();
        (getAnalystClient as jest.Mock).mockResolvedValue({
            client: { chat: { completions: { create: mockCreate } } },
            model: 'gpt-4o',
            provider: 'openai'
        });
    });

    it('returns an empty array for an empty candidate list without calling the LLM', async () => {
        const result = await reassessNpcMoralWeights([]);
        expect(result).toEqual([]);
        expect(getAnalystClient).not.toHaveBeenCalled();
    });

    it('softens moral_impact but keeps ethical_impact when the LLM finds an attenuating motive (Helena case)', async () => {
        // Reproduces the Helena scenario: BETRAYAL scored -8/-8 by the rigid category
        // table, with a dossier description revealing her brother died in the outbreak.
        mockCreate.mockResolvedValue({
            choices: [{
                message: {
                    content: JSON.stringify({
                        reassessments: [
                            { name: 'Helena', moral_impact: -3, ethical_impact: -8, motive: 'agisce per disperazione dopo la morte del fratello' }
                        ]
                    })
                }
            }]
        });

        const result = await reassessNpcMoralWeights([{
            name: 'Helena',
            event: 'Fugge di notte rubando la maschera antigas di un compagno.',
            type: 'BETRAYAL',
            moral_impact: -8,
            ethical_impact: -8,
            dossierDescription: 'Sopravvissuta di Pestum, ha perso il fratello a causa del contagio fungino.',
            recentHistory: '[FIRST_APPEARANCE] Accetta di guidare il gruppo tra le rovine.'
        }]);

        expect(result).toHaveLength(1);
        expect(result[0].moral_impact).toBeGreaterThan(-8);
        expect(result[0].moral_impact).toBe(-3);
        expect(result[0].ethical_impact).toBe(-8);
        expect(result[0].motive).toContain('fratello');
    });

    it('leaves values unchanged when no attenuating motive is found', async () => {
        mockCreate.mockResolvedValue({
            choices: [{
                message: {
                    content: JSON.stringify({
                        reassessments: [
                            { name: 'Villain', moral_impact: -9, ethical_impact: -9, motive: 'nessun movente attenuante trovato' }
                        ]
                    })
                }
            }]
        });

        const result = await reassessNpcMoralWeights([{
            name: 'Villain',
            event: 'Tortura un prigioniero per puro diletto.',
            type: 'REVELATION',
            moral_impact: -9,
            ethical_impact: -9,
            dossierDescription: 'Sadico senza rimorsi.',
            recentHistory: ''
        }]);

        expect(result[0].moral_impact).toBe(-9);
        expect(result[0].ethical_impact).toBe(-9);
    });

    it('falls back to the original values for a candidate missing from the LLM response', async () => {
        mockCreate.mockResolvedValue({
            choices: [{ message: { content: JSON.stringify({ reassessments: [] }) } }]
        });

        const result = await reassessNpcMoralWeights([{
            name: 'Ghost',
            event: 'Evento qualsiasi.',
            type: 'GENERIC',
            moral_impact: -5,
            ethical_impact: -5,
            dossierDescription: '',
            recentHistory: ''
        }]);

        expect(result[0].moral_impact).toBe(-5);
        expect(result[0].ethical_impact).toBe(-5);
    });

    it('fails safe (returns original values) when the LLM call throws', async () => {
        mockCreate.mockRejectedValue(new Error('network error'));

        const result = await reassessNpcMoralWeights([{
            name: 'Errored',
            event: 'Evento qualsiasi.',
            type: 'GENERIC',
            moral_impact: -6,
            ethical_impact: -4,
            dossierDescription: '',
            recentHistory: ''
        }]);

        expect(result[0].moral_impact).toBe(-6);
        expect(result[0].ethical_impact).toBe(-4);
    });

    it('is disabled via DISABLE_MORAL_REASSESSMENT kill-switch', async () => {
        process.env.DISABLE_MORAL_REASSESSMENT = 'true';

        const result = await reassessNpcMoralWeights([{
            name: 'Helena',
            event: 'Fugge di notte.',
            type: 'BETRAYAL',
            moral_impact: -8,
            ethical_impact: -8,
            dossierDescription: '',
            recentHistory: ''
        }]);

        expect(getAnalystClient).not.toHaveBeenCalled();
        expect(result[0].moral_impact).toBe(-8);
        expect(result[0].ethical_impact).toBe(-8);
    });
});
