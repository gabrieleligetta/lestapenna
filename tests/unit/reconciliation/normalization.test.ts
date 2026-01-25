
import { normalizeSummaryNames } from '../../../src/utils/normalize';
import { reconcileNpcName } from '../../../src/bard';

// Mock validateBatch dependencies
jest.mock('../../../src/bard', () => ({
    reconcileNpcName: jest.fn(),
}));

describe('Normalization Logic', () => {
    const CAMPAIGN_ID = 1;

    beforeEach(() => {
        jest.clearAllMocks();
        // Default: no match found, returns null
        (reconcileNpcName as jest.Mock).mockResolvedValue(null);
    });

    it('should strip parenthetical text from NPC names in npc_events', async () => {
        const input = {
            npc_events: [
                { name: 'Pari (guardiano angelico)', type: 'APPEARANCE', event: 'Appears' },
                { name: 'Normal Name', type: 'TALK', event: 'Talks' }
            ]
        };

        const result = await normalizeSummaryNames(CAMPAIGN_ID, input);

        expect(result.npc_events[0].name).toBe('Pari');
        expect(result.npc_events[1].name).toBe('Normal Name');
    });

    it('should strip parenthetical text from present_npcs', async () => {
        const input = {
            present_npcs: ['Mano di Ogma (Avatar)', 'Semplice NPC']
        };

        const result = await normalizeSummaryNames(CAMPAIGN_ID, input);

        expect(result.present_npcs).toContain('Mano di Ogma');
        expect(result.present_npcs).toContain('Semplice NPC');
        expect(result.present_npcs).not.toContain('Mano di Ogma (Avatar)');
    });

    it('should handle complex parentheses usage', async () => {
        const input = {
            npc_events: [
                { name: 'Name (Detail) (More Detail)', type: 'TEST', event: 'Test' },
                { name: 'Name with (inner) text', type: 'TEST', event: 'Test' }
            ]
        };

        const result = await normalizeSummaryNames(CAMPAIGN_ID, input);

        // Expectation: strips all parentheses groups
        expect(result.npc_events[0].name).toBe('Name');
        // "Name with (inner) text" -> "Name with  text" -> "Name with text" (trimmed)
        expect(result.npc_events[1].name).toBe('Name with text');
    });

    it('should maintain canonical name if reconciliation finds one', async () => {
        // Mock reconciliation to return a canonical name
        (reconcileNpcName as jest.Mock).mockResolvedValue({ canonicalName: 'Canonical Pari' });

        const input = {
            npc_events: [
                { name: 'Pari (bad name)', type: 'APPEARANCE', event: 'Appears' }
            ]
        };

        const result = await normalizeSummaryNames(CAMPAIGN_ID, input);

        // The normalization logic should first strip the name to "Pari", 
        // then call reconcileNpcName("Pari").
        // If reconcile returns "Canonical Pari", that should be the result.

        expect(reconcileNpcName).toHaveBeenCalledWith(CAMPAIGN_ID, 'Pari', expect.any(String));
        expect(result.npc_events[0].name).toBe('Canonical Pari');
    });
});
