import type { InventoryCategory } from '../api/types';
import type { IconName } from './icons';

export const CATEGORY_ICONS: Record<InventoryCategory, IconName> = {
    WEAPON: 'weapon',
    ARMOR: 'armor',
    CONSUMABLE: 'potion',
    TOOL: 'tool',
    MATERIAL: 'material',
    TREASURE: 'treasure',
    QUEST_ITEM: 'questItem',
    OTHER: 'inventory',
};

export function inventoryCategoryOf(value: unknown): InventoryCategory {
    const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return normalized in CATEGORY_ICONS ? normalized as InventoryCategory : 'OTHER';
}
