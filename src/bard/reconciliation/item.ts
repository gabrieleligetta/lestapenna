/**
 * Bard reconciliation - Item (inventory): spec for the generic factory
 * (see entityReconciler.ts). Public exports unchanged.
 */

import { listAllInventory } from '../../db';
import { InventoryCategory } from '../../db/types';
import { AI_CONFIRM_SAME_ITEM_PROMPT, AI_CONFIRM_SAME_ITEM_SEMANTIC_PROMPT } from '../prompts';
import { aiConfirmSameEntity } from './semantic';
import { createNameReconciler, createBatchDeduper } from './entityReconciler';

type ItemInput = { name: string; quantity?: number; description?: string; category?: InventoryCategory };

const reconcile = createNameReconciler<any>({
    label: 'Item Reconcile',
    listEntities: listAllInventory,
    getName: i => i.item_name,
    getDescription: i => i.description || '',
    nameThreshold: () => 0.65,
    substringScore: 0.75,
    semanticFragmentType: 'INVENTORY_UPDATE',
    confirmNamePrompt: AI_CONFIRM_SAME_ITEM_PROMPT,
    confirmSemanticPrompt: AI_CONFIRM_SAME_ITEM_SEMANTIC_PROMPT,
});

/**
 * Finds the canonical name when a similar item exists in the inventory.
 */
export async function reconcileItemName(
    campaignId: number,
    item: string | ItemInput
): Promise<{ canonicalName: string; existingItem: any } | null> {
    const itemName = typeof item === 'string' ? item : item.name;
    const itemDesc = typeof item === 'string' ? '' : (item.description || '');
    const match = await reconcile(campaignId, itemName, itemDesc);
    return match ? { canonicalName: match.canonicalName, existingItem: match.existing } : null;
}

/**
 * Pre-dedupes a batch of loot (structured object format).
 */
export const deduplicateItemBatch = createBatchDeduper<ItemInput>({
    label: 'Item Batch Dedup',
    getKey: i => i.name,
    threshold: 0.7,
    confirm: (a, b) => aiConfirmSameEntity(AI_CONFIRM_SAME_ITEM_PROMPT(a, b, ''), 'Item Reconcile'),
    merge: (merged, other) => {
        // Use the longest name, sum the quantities, keep the first available description.
        if (other.name.length > merged.name.length) merged.name = other.name;
        merged.quantity = (merged.quantity || 1) + (other.quantity || 1);
        if (other.description && !merged.description) merged.description = other.description;
        if (other.category && !merged.category) merged.category = other.category;
    },
});
