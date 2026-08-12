import { InventoryCategory } from '../db/types';

/**
 * Keyword-based guess, checked in this order (first match wins) so that more
 * specific buckets (e.g. QUEST_ITEM) don't get shadowed by generic material
 * words. No AI call: inventory items are created in bulk during ingestion and
 * a per-item LLM classification would multiply request volume for little gain
 * (see src/bard/sync/inventory.ts for the same cost tradeoff on RAG sync).
 */
const CATEGORY_KEYWORDS: Array<[InventoryCategory, RegExp]> = [
    [
        'QUEST_ITEM',
        /\b(sigill[oi]|medaglion[ei]|amuleto della missione|frammento della|diario di|mappa del tesoro|chiave del|reliquia della missione)\b/i,
    ],
    [
        'WEAPON',
        /\b(spad[ae]|spadone|ascia|asce|arco|balestr[ae]|pugnal[ei]|stiletto|mazz[ae]|lanci[ae]|martell[oi]|frust[ae]|katana|scimitarr[ae]|alabard[ae]|coltell[oi]|sword|axe|bow|crossbow|dagger|mace|spear|hammer|whip|blade)\b/i,
    ],
    [
        'ARMOR',
        /\b(armatur[ae]|corazz[ae]|scud[oi]|elm[oi]|gambali|cotta di maglia|maglia di ferro|corpetto|mantell[oi]|guanti da combattimento|stivali di ferro|armor|armour|shield|helmet|breastplate|gauntlets|cloak)\b/i,
    ],
    [
        'CONSUMABLE',
        /\b(pozion[ei]|elisir|antidoto|veleno|unguent[oi]|pillol[ae]|rimedi[oi]|razion[ei] di cibo|cibo|pane|acqua potabile|pergamen[ae]|potion|elixir|poison|antidote|ration|scroll|salve)\b/i,
    ],
    [
        'TOOL',
        /\b(cord[ae]|torci[ae]|kit di|grimaldell[oi]|lanterna|zain[oi]|attrezzi|strumenti da|chiavi inglesi|rope|torch|lockpick|lantern|toolkit|piccone|vanga)\b/i,
    ],
    [
        'TREASURE',
        /\b(gemm[ae]|gioiell[oi]|monet[ae]|monete d'oro|oro puro|argento puro|tesoro|collan[ae]|anell[oi]|corona|diadema|gem|jewel|coin|gold coin|treasure|necklace|ring|crown)\b/i,
    ],
    [
        'MATERIAL',
        /\b(minerale|pell[ei] grezz[ae]|legno grezzo|ferro grezzo|cristall[oi] grezz[oi]|erba|componente|materiale grezzo|ore|hide|raw wood|raw iron|crystal shard|herb|component)\b/i,
    ],
];

/** Guesses an inventory category from the item name/description; falls back to 'OTHER'. */
export function guessInventoryCategory(itemName: string, description?: string | null): InventoryCategory {
    const haystack = `${itemName} ${description ?? ''}`;
    for (const [category, pattern] of CATEGORY_KEYWORDS) {
        if (pattern.test(haystack)) return category;
    }
    return 'OTHER';
}
