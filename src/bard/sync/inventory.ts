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

    // 1. Check for Artifact Match first
    const { getArtifactByName } = await import('../../db');
    const artifact = getArtifactByName(campaignId, itemName);

    let ragContent = `[[SCHEDA OGGETTO UFFICIALE: ${itemName}]]\n`;
    ragContent += `QUANTITÀ: ${item.quantity}\n`;

    if (artifact) {
        console.log(`[Sync] ${itemName} identificato come Artefatto. Link alla scheda.`);
        ragContent += `IDENTIFICAZIONE: Questo oggetto è un Artefatto conosciuto.\n`;
        ragContent += `RIFERIMENTO: Vedi [[SCHEDA ARTEFATTO UFFICIALE: ${itemName}]] per la storia e i poteri completi.\n`;
        // Non generiamo bio per l'inventario se è un artefatto, usiamo quella dell'artefatto (gestita in artifact.ts)
    } else {
        // Oggetto comune/standard - Usa descrizione manuale o default, NIENTE AI (Risparmio Costi)
        const description = (item as any).manual_description || item.description || "Oggetto standard dell'inventario.";
        ragContent += `DESCRIZIONE: ${description}\n`;
    }

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

    console.log(`[Sync] 📥 Inizio sync per ${dirty.length} oggetti inventario...`);

    const { getArtifactByName } = await import('../../db'); // Lazy load

    // 1. Separate Artifacts vs Items
    const normalItems = [];
    const artifacts = [];

    for (const item of dirty) {
        // Quick check if artifact exists with same name
        const artifact = getArtifactByName(campaignId, item.item_name);
        if (artifact) {
            artifacts.push(item);
        } else {
            normalItems.push(item);
        }
    }

    // 2. Process Artifact-Items (Just Sync RAG Link, No Bio Gen)
    for (const item of artifacts) {
        // ... (Logic from old syncInventoryEntryIfNeeded)
        await finalizeInventorySync(campaignId, item, undefined, true);
    }

    // 3. Process Normal Items (Optimization: NO AI, just RAG Sync)
    // User requested to avoid AI costs for standard items
    for (const item of normalItems) {
        const manualDesc = (item as any).manual_description;
        const currentDesc = item.description;

        // Use manual desc if exists, else current desc, else default
        // We do NOT call generateBioBatch here.
        const finalDesc = manualDesc || currentDesc || "Oggetto standard dell'inventario.";

        await finalizeInventorySync(campaignId, item, finalDesc, false);
    }

    return dirty.length;
}

async function finalizeInventorySync(campaignId: number, item: any, newDesc: string | undefined, isArtifact: boolean) {
    const { inventoryRepository } = await import('../../db/repositories/InventoryRepository');

    // Update DB if new description (and not artifact)
    if (!isArtifact && newDesc) {
        inventoryRepository.updateInventoryDescription(campaignId, item.item_name, newDesc);
    }

    // Build RAG
    let ragContent = `[[SCHEDA OGGETTO UFFICIALE: ${item.item_name}]]\n`;
    ragContent += `QUANTITÀ: ${item.quantity}\n`;

    if (isArtifact) {
        ragContent += `IDENTIFICAZIONE: Questo oggetto è un Artefatto conosciuto.\n`;
        ragContent += `RIFERIMENTO: Vedi [[SCHEDA ARTEFATTO UFFICIALE: ${item.item_name}]] per la storia e i poteri completi.\n`;
    } else {
        const desc = newDesc || item.description || "Oggetto inventario.";
        ragContent += `DESCRIZIONE: ${desc}\n`;
    }

    if (item.notes) ragContent += `NOTE: ${item.notes}\n`;
    ragContent += `\n(Questa scheda ufficiale ha priorità su informazioni frammentarie precedenti)`;

    // Ingest
    await ingestGenericEvent(
        campaignId,
        'INVENTORY_UPDATE',
        ragContent,
        [],
        'INVENTORY'
    );

    clearInventoryDirtyFlag(campaignId, item.item_name);
    console.log(`[Sync] ✅ Inventario ${item.item_name} sincronizzato.`);
}
