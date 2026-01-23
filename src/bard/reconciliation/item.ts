/**
 * Bard Reconciliation - Item (Inventory) reconciliation
 */

import { listAllInventory } from '../../db';
import { metadataClient, METADATA_MODEL } from '../config';
import { levenshteinSimilarity, containsSubstring } from '../helpers';

/**
 * Chiede all'AI se due oggetti sono lo stesso item.
 */
async function aiConfirmSameItem(item1: string, item2: string, context: string = ""): Promise<boolean> {
    const prompt = `Sei un esperto di D&D e oggetti fantasy. Rispondi SOLO con "SI" o "NO".

Domanda: "${item1}" e "${item2}" sono lo STESSO oggetto?

Considera che:
- Potrebbero essere abbreviazioni (es. "Pozione di cura" = "Pozione Cura")
- Potrebbero essere varianti (es. "100 monete d'oro" ≈ "100 mo")
- NON unire oggetti diversi (es. "Spada +1" ≠ "Spada +2")
- NON unire categorie diverse (es. "Pozione di cura" ≠ "Pozione di forza")

${context ? `Contesto: ${context}` : ''}

Rispondi SOLO: SI oppure NO`;

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
    newItem: string
): Promise<{ canonicalName: string; existingItem: any } | null> {
    const existingItems = listAllInventory(campaignId);
    if (existingItems.length === 0) return null;

    const newItemLower = newItem.toLowerCase().trim();

    const exactMatch = existingItems.find((i: any) => i.item_name.toLowerCase() === newItemLower);
    if (exactMatch) return null;

    const candidates: Array<{ item: any; similarity: number; reason: string }> = [];

    for (const item of existingItems) {
        const existingName = item.item_name;
        const similarity = levenshteinSimilarity(newItem, existingName);

        if (similarity >= 0.65) {
            candidates.push({ item, similarity, reason: `levenshtein=${similarity.toFixed(2)}` });
            continue;
        }

        if (containsSubstring(newItem, existingName)) {
            candidates.push({ item, similarity: 0.75, reason: 'substring_match' });
        }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.similarity - a.similarity);

    for (const candidate of candidates.slice(0, 3)) {
        console.log(`[Item Reconcile] 🔍 "${newItem}" simile a "${candidate.item.item_name}" (${candidate.reason}). Chiedo conferma AI...`);

        const isSame = await aiConfirmSameItem(newItem, candidate.item.item_name);

        if (isSame) {
            console.log(`[Item Reconcile] ✅ CONFERMATO: "${newItem}" = "${candidate.item.item_name}"`);
            return { canonicalName: candidate.item.item_name, existingItem: candidate.item };
        } else {
            console.log(`[Item Reconcile] ❌ "${newItem}" ≠ "${candidate.item.item_name}"`);
        }
    }

    return null;
}

/**
 * Pre-deduplica un batch di loot.
 */
export async function deduplicateItemBatch(
    items: string[]
): Promise<string[]> {
    if (items.length <= 1) return items;

    const result: string[] = [];
    const processed = new Set<number>();

    for (let i = 0; i < items.length; i++) {
        if (processed.has(i)) continue;

        let merged = items[i];
        processed.add(i);

        for (let j = i + 1; j < items.length; j++) {
            if (processed.has(j)) continue;

            const similarity = levenshteinSimilarity(merged, items[j]);
            const hasSubstring = containsSubstring(merged, items[j]);

            if (similarity > 0.7 || hasSubstring) {
                const isSame = await aiConfirmSameItem(merged, items[j]);

                if (isSame) {
                    console.log(`[Item Batch Dedup] 🔄 "${items[j]}" → "${merged}"`);
                    if (items[j].length > merged.length) {
                        merged = items[j];
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
