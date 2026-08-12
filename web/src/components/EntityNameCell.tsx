import type { EntityRow } from '../api/types';
import { EntityThumbnail } from './EntityMedia';
import { entityImageFrom } from './entityMediaModel';
import type { IconName } from './icons';

export function EntityNameCell({
    row,
    field,
    icon,
    shape,
}: {
    row: EntityRow;
    field: string;
    icon: IconName;
    shape?: 'portrait' | 'landscape' | 'square';
}) {
    return (
        <span className="entity-name-cell">
            <EntityThumbnail image={entityImageFrom(row.image)} icon={icon} shape={shape} />
            <span className="entity-name-cell__copy">
                <span>{String(row[field] ?? '—')}</span>
            </span>
        </span>
    );
}
