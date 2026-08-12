
/**
 * The inventory sync goes through `ingestEntitySnapshot` (a single card per
 * item), no longer through `ingestGenericEvent`: the test asserted on the mock of the
 * old function, which was never called, and read `calls[0]` of an
 * empty array.
 */
import { syncInventoryEntryIfNeeded } from '../../../../src/bard/sync/inventory';
import * as db from '../../../../src/db';
import * as rag from '../../../../src/bard/rag';

// Mocks
jest.mock('../../../../src/db');
jest.mock('../../../../src/bard/rag');

describe('Inventory Optimization', () => {
    const mockDb = db as jest.Mocked<typeof db>;
    const mockRag = rag as jest.Mocked<typeof rag>;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('should NOT generate bio for standard items (Currency/Standard)', async () => {
        // Setup standard item
        mockDb.getInventoryItemByName.mockReturnValue({
            id: 1,
            item_name: '450 mo',
            quantity: 450,
            rag_sync_needed: 1,
            campaign_id: 1,
            acquired_at: Date.now(),
            last_updated: Date.now(),
            session_id: 's1',
            is_manual: 0
        } as any);

        // Mock Artifact check to return null (not an artifact)
        mockDb.getArtifactByName.mockReturnValue(null);

        await syncInventoryEntryIfNeeded(1, '450 mo');

        // No bio generation: the inventory sync no longer imports
        // generateBio, so it is enough to look at what ends up in the RAG.
        expect(mockRag.ingestEntitySnapshot).toHaveBeenCalled();
        const ragContent = mockRag.ingestEntitySnapshot.mock.calls[0][2];

        // Should use default description
        expect(ragContent).toContain("Oggetto standard dell'inventario");
        expect(ragContent).not.toContain("LEGGENDA:");
    });

    test('should link to Artifact if item is an Artifact', async () => {
        // Setup item that is also an artifact
        mockDb.getInventoryItemByName.mockReturnValue({
            id: 2,
            item_name: 'Anello del Potere',
            quantity: 1,
            rag_sync_needed: 1,
            campaign_id: 1,
            acquired_at: Date.now(),
            last_updated: Date.now(),
            session_id: 's1',
            is_manual: 0
        } as any);

        // Mock Artifact check to return the artifact
        mockDb.getArtifactByName.mockReturnValue({
            id: 10,
            campaign_id: 1,
            name: 'Anello del Potere',
            description: 'Un anello molto potente',
            is_analyzed: 1
        } as any);

        await syncInventoryEntryIfNeeded(1, 'Anello del Potere');

        const ragContent = mockRag.ingestEntitySnapshot.mock.calls[0][2];

        // Should contain link to artifact
        expect(ragContent).toContain("IDENTIFICAZIONE: Questo oggetto è un Artefatto conosciuto");
        expect(ragContent).toContain("[[SCHEDA ARTEFATTO UFFICIALE: Anello del Potere]]");
    });
});
