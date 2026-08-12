import type { InventoryCategory } from '../api/types';
import { useT } from '../i18n';
import { Badge } from './Badge';
import { CATEGORY_ICONS, inventoryCategoryOf } from './inventoryPresentation';
import { Icon } from './icons';

export function InventoryCategoryBadge({ category }: { category: InventoryCategory | string | null | undefined }) {
    const t = useT();
    const normalized = inventoryCategoryOf(category);

    return (
        <Badge tone="neutral">
            <Icon name={CATEGORY_ICONS[normalized]} className="badge-icon" />
            <span>{t.inventory.categories[normalized]}</span>
        </Badge>
    );
}
