/**
 * Bard Reconciliation - Item (Inventory) reconciliation
 */

import { listAllInventory } from '../../db';
import { metadataClient, METADATA_MODEL } from '../config';
import { levenshteinSimilarity, containsSubstring } from '../helpers';
import { AI_CONFIRM_SAME_ITEM_PROMPT } from '../prompts';

/**
 * Chiede all'AI se due oggetti sono lo stesso item.
 */
async function aiConfirmSameItem(item1: string, item2: string, context: string = ""): Promise<boolean> {
    const prompt = AI_CONFIRM_SAME_ITEM_PROMPT(item1, item2, context);

    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 5
        });
        const answer = response.choices[0].message.content?.toUpperCase().trim() || "";
        return answer.includes("SI") || answer.includes("SÌ") || answer === "YES";
    } catch (e) {
        console.error("[Item Reconcile] ❌ Errore AI confirm:", e);
        return false;
    }
}

/**
 * Trova il nome canonico se esiste un oggetto simile nell'inventario.
 */
export async function reconcileItemName(
    campaignId: number,
    item: string | { name: string; quantity?: number; description?: string }
): Promise<{ canonicalName: string; existingItem: any } | null> {
    const itemName = typeof item === 'string' ? item : item.name;
    const existingItems = listAllInventory(campaignId);
    if (existingItems.length === 0) return null;

    const newItemLower = itemName.toLowerCase().trim();

    const exactMatch = existingItems.find((i: any) => i.item_name.toLowerCase() === newItemLower);
    if (exactMatch) return null;

    const candidates: Array<{ item: any; similarity: number; reason: string }> = [];

    for (const existingItem of existingItems) {
        const existingName = existingItem.item_name;
        const similarity = levenshteinSimilarity(itemName, existingName);

        if (similarity >= 0.65) {
            candidates.push({ item: existingItem, similarity, reason: `levenshtein=${similarity.toFixed(2)}` });
            continue;
        }

        if (containsSubstring(itemName, existingName)) {
            candidates.push({ item: existingItem, similarity: 0.75, reason: 'substring_match' });
        }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.similarity - a.similarity);

    for (const candidate of candidates.slice(0, 3)) {
        console.log(`[Item Reconcile] 🔍 "${itemName}" simile a "${candidate.item.item_name}" (${candidate.reason}). Chiedo conferma AI...`);

        const isSame = await aiConfirmSameItem(itemName, candidate.item.item_name);

        if (isSame) {
            console.log(`[Item Reconcile] ✅ CONFERMATO: "${itemName}" = "${candidate.item.item_name}"`);
            return { canonicalName: candidate.item.item_name, existingItem: candidate.item };
        } else {
            console.log(`[Item Reconcile] ❌ "${itemName}" ≠ "${candidate.item.item_name}"`);
        }
    }

    return null;
}

/**
 * Pre-deduplica un batch di loot (formato oggetto strutturato).
 */
export async function deduplicateItemBatch(
    items: Array<{ name: string; quantity?: number; description?: string }>
): Promise<Array<{ name: string; quantity?: number; description?: string }>> {
    if (items.length <= 1) return items;

    const result: Array<{ name: string; quantity?: number; description?: string }> = [];
    const processed = new Set<number>();

    for (let i = 0; i < items.length; i++) {
        if (processed.has(i)) continue;

        let merged = { ...items[i] };
        processed.add(i);

        for (let j = i + 1; j < items.length; j++) {
            if (processed.has(j)) continue;

            const similarity = levenshteinSimilarity(merged.name, items[j].name);
            const hasSubstring = containsSubstring(merged.name, items[j].name);

            if (similarity > 0.7 || hasSubstring) {
                const isSame = await aiConfirmSameItem(merged.name, items[j].name);

                if (isSame) {
                    console.log(`[Item Batch Dedup] 🔄 "${items[j].name}" → "${merged.name}"`);
                    // Usa il nome più lungo
                    if (items[j].name.length > merged.name.length) {
                        merged.name = items[j].name;
                    }
                    // Somma le quantità
                    merged.quantity = (merged.quantity || 1) + (items[j].quantity || 1);
                    // Unisci descrizioni se presenti
                    if (items[j].description && !merged.description) {
                        merged.description = items[j].description;
                    }
                    processed.add(j);
                }
            }
        }

        result.push(merged);
    }

    if (result.length < items.length) {
        console.log(`[Item Batch Dedup] ✅ Ridotti ${items.length} oggetti a ${result.length}`);
    }

    return result;
}
