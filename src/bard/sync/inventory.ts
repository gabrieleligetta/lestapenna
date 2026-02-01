/**
 * Bard Sync - Inventory synchronization functions
 */

import { getInventoryItemByName, clearInventoryDirtyFlag, getDirtyInventoryItems } from '../../db';
import { ingestGenericEvent } from '../rag';
import { generateBio } from '../bio';

/**
 * Sincronizza Inventory Item nel RAG (con rigenerazione bio)
 */
export async function syncInventoryEntryIfNeeded(
    campaignId: number,
    itemName: string,
    force: boolean = false
): Promise<void> {

    const item = getInventoryItemByName(campaignId, itemName);
    if (!item) return;

    const needsSync = (item as any).rag_sync_needed === 1;
    if (!force && !needsSync) return;

    console.log(`[Sync] Avvio sync Inventario per ${itemName}...`);

    // 1. Fetch History and Generate Bio
    const { inventoryRepository } = await import('../../db/repositories/InventoryRepository');
    const history = inventoryRepository.getInventoryHistory(campaignId, itemName);
    const simpleHistory = history.map((h: any) => ({ description: h.description, event_type: h.event_type }));

    const newBio = await generateBio('ITEM', {
        campaignId,
        name: itemName,
        currentDesc: item.description || '',
        manualDescription: (item as any).manual_description || undefined // 🆕 Passa la descrizione manuale
    }, simpleHistory);

    // 2. Build RAG content
    let ragContent = `[[SCHEDA OGGETTO UFFICIALE: ${itemName}]]\n`;
    ragContent += `QUANTITÀ: ${item.quantity}\n`;
    if (newBio) ragContent += `LEGGENDA: ${newBio}\n`;
    if (item.notes) ragContent += `NOTE: ${item.notes}\n`;
    ragContent += `\n(Questa scheda ufficiale ha priorità su informazioni frammentarie precedenti)`;

    await ingestGenericEvent(
        campaignId,
        'INVENTORY_UPDATE',
        ragContent,
        [],
        'INVENTORY'
    );

    clearInventoryDirtyFlag(campaignId, itemName);
    console.log(`[Sync] Inventario ${itemName} sincronizzato.`);
}

/**
 * Batch sync di tutti gli oggetti dirty
 */
export async function syncAllDirtyInventory(campaignId: number): Promise<number> {
    const dirty = getDirtyInventoryItems(campaignId);

    if (dirty.length === 0) return 0;

    console.log(`[Sync] Sincronizzazione batch di ${dirty.length} oggetti inventario...`);

    for (const item of dirty) {
        try {
            await syncInventoryEntryIfNeeded(campaignId, item.item_name, true);
        } catch (e) {
            console.error(`[Sync] Errore sync oggetto ${item.item_name}:`, e);
        }
    }

    return dirty.length;
}
