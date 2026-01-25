/**
 * Bard Sync - Inventory synchronization functions
 */

import { getInventoryItemByName, clearInventoryDirtyFlag, getDirtyInventoryItems } from '../../db';
import { ingestGenericEvent } from '../rag';

/**
 * Sincronizza Inventory Item nel RAG
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

    let ragContent = `[[OGGETTO INVENTARIO: ${itemName}]]\n`;
    ragContent += `QUANTITÀ: ${item.quantity}\n`;
    if (item.description) ragContent += `DESCRIZIONE: ${item.description}\n`;
    if (item.notes) ragContent += `NOTE: ${item.notes}\n`;

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
