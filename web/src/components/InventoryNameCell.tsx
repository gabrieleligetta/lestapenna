import type { EntityRow } from '../api/types';
import { useT } from '../i18n';
import { EntityThumbnail } from './EntityMedia';
import { entityImageFrom } from './entityMediaModel';
import { CATEGORY_ICONS, inventoryCategoryOf } from './inventoryPresentation';

export function InventoryNameCell({ row }: { row: EntityRow }) {
    const t = useT();
    const category = inventoryCategoryOf(row.category);
    const isArtifact = row.is_artifact === true || row.is_artifact === 1;
    const isCursed = row.is_cursed === true || row.is_cursed === 1;
    const icon = isArtifact ? 'artifacts' : CATEGORY_ICONS[category];
    const labels = [
        category !== 'OTHER' ? t.inventory.categories[category] : null,
        isArtifact ? t.inventory.artifact : null,
        isCursed ? t.inventory.cursed : null,
    ].filter(Boolean);

    return (
        <span className="entity-name-cell">
            <EntityThumbnail image={entityImageFrom(row.image)} icon={icon} />
            <span className="entity-name-cell__copy">
                <span>{String(row.item_name ?? '—')}</span>
                {labels.length > 0 && <small>{labels.join(' · ')}</small>}
            </span>
        </span>
    );
}
