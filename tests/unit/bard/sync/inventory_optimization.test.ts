
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

        // Verify NO bio generation call (we need to ensure generateBio is NOT imported/called, 
        // but since we modified the file to remove the import, checking the RAG content is enough)

        // Check RAG Ingestion content
        expect(mockRag.ingestGenericEvent).toHaveBeenCalled();
        const callArgs = mockRag.ingestGenericEvent.mock.calls[0];
        const ragContent = callArgs[2];

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

        const callArgs = mockRag.ingestGenericEvent.mock.calls[0];
        const ragContent = callArgs[2];

        // Should contain link to artifact
        expect(ragContent).toContain("IDENTIFICAZIONE: Questo oggetto è un Artefatto conosciuto");
        expect(ragContent).toContain("[[SCHEDA ARTEFATTO UFFICIALE: Anello del Potere]]");
    });
});
