import type { EntityRow, EntityType } from '../api/types';
import type { Messages } from '../i18n/messages';
import type { Column } from '../components/DataTable';
import { AlignmentCell } from '../components/AlignmentCell';
import type { EthicalAlignment, MoralAlignment } from '../components/AlignmentBar';
import { ReputationMeter } from '../components/ReputationMeter';
import type { ReputationLevel } from '../api/types';
import { StatusBadge } from '../components/StatusBadge';
import { InventoryNameCell } from '../components/InventoryNameCell';
import { EntityNameCell } from '../components/EntityNameCell';

/** Column headers used to be English literals in all six locales; they are keys now. */
type FieldKey = keyof Messages['fields'];

interface ColumnSpec {
    key: string;
    labelKey: FieldKey;
    /** Defaults to the plain formatted value of `key`. */
    render?: (row: EntityRow) => React.ReactNode;
    /** Public sort key, matching the SORTABLE whitelist in campaigns.controller.ts. */
    sortKey?: string;
}

/** Which entity types the API can filter by status. */
export const STATUS_FILTERS: Partial<Record<EntityType, string[]>> = {
    quests: ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'FAILED'],
};

function alignment(row: EntityRow) {
    return (
        <AlignmentCell
            moral={(row.alignment_moral as MoralAlignment | null) ?? null}
            ethical={(row.alignment_ethical as EthicalAlignment | null) ?? null}
        />
    );
}

/** Curated columns per entity type; anything else falls back to auto-columns from the row keys. */
const SPECS: Partial<Record<EntityType, ColumnSpec[]>> = {
    characters: [
        {
            key: 'character_name',
            labelKey: 'name',
            sortKey: 'name',
            render: (row) => <EntityNameCell row={row} field="character_name" icon="characters" shape="portrait" />,
        },
        { key: 'race', labelKey: 'race', sortKey: 'race' },
        { key: 'class', labelKey: 'class', sortKey: 'class' },
        { key: 'alignment', labelKey: 'alignment', render: alignment },
    ],
    npcs: [
        {
            key: 'name',
            labelKey: 'name',
            sortKey: 'name',
            render: (row) => <EntityNameCell row={row} field="name" icon="npcs" shape="portrait" />,
        },
        { key: 'status', labelKey: 'status', sortKey: 'status' },
        { key: 'role', labelKey: 'role', sortKey: 'role' },
        { key: 'alignment', labelKey: 'alignment', render: alignment },
    ],
    locations: [
        {
            key: 'micro_location',
            labelKey: 'place',
            sortKey: 'place',
            render: (row) => <EntityNameCell row={row} field="micro_location" icon="locations" shape="landscape" />,
        },
        { key: 'macro_location', labelKey: 'region', sortKey: 'region' },
    ],
    factions: [
        { key: 'name', labelKey: 'name', sortKey: 'name' },
        { key: 'status', labelKey: 'status', sortKey: 'status' },
        { key: 'alignment', labelKey: 'alignment', render: alignment },
        {
            key: 'reputation',
            labelKey: 'reputation',
            // The party faction has no standing with itself.
            render: (row) =>
                row.is_party === 1 ? (
                    <span className="muted">—</span>
                ) : (
                    <ReputationMeter level={(row.reputation as ReputationLevel) ?? 'NEUTRAL'} />
                ),
        },
    ],
    quests: [
        { key: 'title', labelKey: 'title' },
        { key: 'status', labelKey: 'status' },
    ],
    inventory: [
        { key: 'item_name', labelKey: 'item', render: (row) => <InventoryNameCell row={row} /> },
        { key: 'quantity', labelKey: 'quantity' },
    ],
    artifacts: [
        {
            key: 'name',
            labelKey: 'name',
            sortKey: 'name',
            render: (row) => <EntityNameCell row={row} field="name" icon="artifacts" />,
        },
        { key: 'status', labelKey: 'status', sortKey: 'status' },
    ],
    bestiary: [
        { key: 'name', labelKey: 'name', sortKey: 'name' },
        { key: 'status', labelKey: 'status', sortKey: 'status' },
    ],
    sessions: [
        { key: 'session_number', labelKey: 'number' },
        { key: 'title', labelKey: 'title' },
        { key: 'start_time', labelKey: 'date' },
    ],
};

/** Resolves the specs against the active locale, ready for <DataTable>. */
export function columnsFor(
    type: EntityType,
    t: Messages,
    sample: EntityRow | undefined,
    locale?: string,
): Array<Column<EntityRow>> {
    const specs = SPECS[type];
    if (!specs) {
        return Object.keys(sample ?? {}).map((key) => ({
            key,
            label: key,
            render: (row: EntityRow) => formatCellValue(row[key], key, locale),
        }));
    }
    return specs.map((spec) => ({
        key: spec.key,
        label: t.fields[spec.labelKey],
        sortKey: spec.sortKey,
        render: spec.render ?? ((row: EntityRow) =>
            spec.key === 'status'
                ? <StatusBadge status={row[spec.key] == null ? null : String(row[spec.key])} />
                : formatCellValue(row[spec.key], spec.key, locale)),
    }));
}

/** Which row field is the identifier to link to the detail route — short_id for most, but characters/sessions differ (see the web app's data map). */
export const ID_FIELD: Record<EntityType, string> = {
    characters: 'user_id',
    npcs: 'short_id',
    locations: 'short_id',
    factions: 'short_id',
    quests: 'short_id',
    inventory: 'short_id',
    artifacts: 'short_id',
    bestiary: 'short_id',
    timeline: 'short_id',
    sessions: 'session_id',
};

/**
 * Fields to drop from the generic detail dump.
 *
 * Still needed: the DTO projections cover the list endpoints, but the detail
 * endpoints still return whole rows, so the plumbing columns are still there to
 * be filtered. Fase 2's typed detail views retire this.
 */
export const HIDDEN_DETAIL_FIELDS = new Set([
    'id',
    'campaign_id',
    'rag_sync_needed',
    'is_manual',
    'manual_description',
    'first_session_id',
    'last_updated_session_id',
    'owner_id',
    'owner_type',
    'faction_id',
    'entity_id',
]);

export function formatCellValue(value: unknown, key: string, locale?: string): string {
    if (value === null || value === undefined) return '—';
    const dateKeys = new Set(['start_time', 'timestamp', 'acquired_at', 'last_seen', 'last_updated']);
    if (dateKeys.has(key) && typeof value === 'number') {
        const milliseconds = value < 100_000_000_000 ? value * 1_000 : value;
        return new Date(milliseconds).toLocaleDateString(locale);
    }
    if (typeof value === 'string' && value.startsWith('[')) {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) return parsed.join(' · ');
        } catch {
            // Not JSON after all — render the source string below.
        }
    }
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}
