/**
 * Bard Sync - Inventory: sync towards the RAG.
 * NO AI here, as a cost choice: ordinary items use the manual/current
 * description; items that turn out to be Artifacts are merely linked
 * to their card (artifact.ts handles the bio). Single card builder.
 */

import { getInventoryItemByName, clearInventoryDirtyFlag, getDirtyInventoryItems, getArtifactByName } from '../../db';
import { inventoryRepository } from '../../db/repositories/InventoryRepository';
import { ingestEntitySnapshot } from '../rag';
import { RAG_PRIORITY_FOOTER } from './entitySync';

function buildInventoryRagContent(item: any, description: string | undefined, isArtifact: boolean): string {
    let ragContent = `[[SCHEDA OGGETTO UFFICIALE: ${item.item_name}]]\n`;
    ragContent += `QUANTITÀ: ${item.quantity}\n`;

    if (isArtifact) {
        ragContent += `IDENTIFICAZIONE: Questo oggetto è un Artefatto conosciuto.\n`;
        ragContent += `RIFERIMENTO: Vedi [[SCHEDA ARTEFATTO UFFICIALE: ${item.item_name}]] per la storia e i poteri completi.\n`;
    } else {
        ragContent += `DESCRIZIONE: ${description || item.description || "Oggetto standard dell'inventario."}\n`;
    }

    if (item.notes) ragContent += `NOTE: ${item.notes}\n`;
    return ragContent + RAG_PRIORITY_FOOTER;
}

async function finalizeInventorySync(campaignId: number, item: any, newDesc: string | undefined, isArtifact: boolean): Promise<void> {
    if (!isArtifact && newDesc) {
        inventoryRepository.updateInventoryDescription(campaignId, item.item_name, newDesc);
    }

    await ingestEntitySnapshot(
        campaignId,
        'INVENTORY_UPDATE',
        buildInventoryRagContent(item, newDesc, isArtifact),
        [],
        'INVENTORY'
    );

    clearInventoryDirtyFlag(campaignId, item.item_name);
    console.log(`[Sync] ✅ Inventario ${item.item_name} sincronizzato.`);
}

/**
 * Syncs a single inventory item into the RAG.
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

    const artifact = getArtifactByName(campaignId, itemName);
    if (artifact) {
        console.log(`[Sync] ${itemName} identificato come Artefatto. Link alla scheda.`);
        await finalizeInventorySync(campaignId, item, undefined, true);
    } else {
        const description = (item as any).manual_description || item.description || "Oggetto standard dell'inventario.";
        await finalizeInventorySync(campaignId, item, description, false);
    }
}

/**
 * Batch sync of every dirty item.
 */
export async function syncAllDirtyInventory(campaignId: number): Promise<number> {
    const dirty = getDirtyInventoryItems(campaignId);
    if (dirty.length === 0) return 0;

    console.log(`[Sync] 📥 Inizio sync per ${dirty.length} oggetti inventario...`);

    for (const item of dirty) {
        const isArtifact = Boolean(getArtifactByName(campaignId, item.item_name));
        const finalDesc = isArtifact
            ? undefined
            : (item as any).manual_description || item.description || "Oggetto standard dell'inventario.";

        await finalizeInventorySync(campaignId, item, finalDesc, isArtifact);
    }

    return dirty.length;
}
