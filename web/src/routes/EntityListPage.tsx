import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useCampaignEntityList, useCampaignPermissions } from '../api/hooks';
import { useLocale, useT } from '../i18n';
import {
    isCrudEntityType,
    isMergeableEntityType,
    type EntityRow,
    type EntityType,
    type InventoryCategory,
} from '../api/types';
import { columnsFor, ID_FIELD, STATUS_FILTERS } from './entityConfig';
import { DataTable } from '../components/DataTable';
import { SearchInput } from '../components/SearchInput';
import { Empty, ErrorState, Loading } from '../components/StateViews';
import { statusLabel } from '../components/statusPresentation';
import { Icon } from '../components/icons';
import { WorldTimeline } from '../components/WorldTimeline';
import { MergeDuplicatesModal } from '../components/MergeDuplicatesModal';
import { CATEGORY_ICONS } from '../components/inventoryPresentation';
import { EntityEditorModal } from '../components/EntityEditorModal';
import { QuestSuggestionsPanel } from '../components/QuestSuggestionsPanel';

const PAGE_SIZE = 25;

export function EntityListPage() {
    const { guildId = '', campaignId = '', entityType = '' } = useParams();
    const t = useT();
    const { locale } = useLocale();

    /**
     * All list state lives in the URL, not useState: a filtered, sorted view is
     * then a link someone can send to their table, and the back button steps
     * through it the way a user expects.
     */
    const [params, setParams] = useSearchParams();
    const offset = Number(params.get('offset') ?? 0);
    const sortKey = params.get('sort') ?? '';
    const direction = params.get('dir') === 'desc' ? 'desc' : 'asc';
    const search = params.get('q') ?? '';
    const status = params.get('status') ?? '';
    const category = params.get('category') ?? '';

    const patch = useCallback(
        (changes: Record<string, string | null>, { resetOffset = true } = {}) => {
            const next = new URLSearchParams(params);
            for (const [key, value] of Object.entries(changes)) {
                if (value === null || value === '') next.delete(key);
                else next.set(key, value);
            }
            // Any change to what is being listed invalidates the current page
            // number — otherwise a search lands you on page 4 of 1.
            if (resetOffset) next.delete('offset');
            setParams(next, { replace: true });
        },
        [params, setParams],
    );

    const type = entityType as EntityType;
    const { data, isLoading, isFetching, isError, error } = useCampaignEntityList(campaignId, type, {
        limit: PAGE_SIZE,
        offset,
        sort: sortKey || undefined,
        dir: sortKey ? direction : undefined,
        q: search || undefined,
        status: status || undefined,
        category: category || undefined,
    });

    const title = type in t.entities ? t.entities[type] : entityType;
    const statuses = STATUS_FILTERS[type];

    // Writing to the campaign — CRUD, merge, AI audit — is for members of the
    // table: the permission comes from the server, not from being an administrator
    // of the Discord guild.
    const { canWrite } = useCampaignPermissions(campaignId);
    const [mergeOpen, setMergeOpen] = useState(false);
    const [editorOpen, setEditorOpen] = useState(false);
    // Characters and sessions are not created from here: they are born from a
    // Discord user and from a recording (see CRUD_ENTITY_TYPES on the API side).
    const canCreate = canWrite && isCrudEntityType(type);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const selectedShortIds = useMemo(() => Array.from(selected), [selected]);
    const mergeable = isMergeableEntityType(type);

    useEffect(() => {
        setSelected(new Set());
        setMergeOpen(false);
    }, [campaignId, type]);

    const toggleSelect = useCallback((key: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    const toggleSelectAll = useCallback((keys: string[], shouldSelect: boolean) => {
        setSelected((prev) => {
            const next = new Set(prev);
            for (const key of keys) {
                if (shouldSelect) next.add(key);
                else next.delete(key);
            }
            return next;
        });
    }, []);

    const heading = (
        <header className="entity-page-header">
            <span className="entity-page-header__icon" aria-hidden="true">
                <Icon name={type} />
            </span>
            <div>
                <h1>{title}</h1>
                {type === 'timeline' && <p>{t.timeline.subtitle}</p>}
            </div>
            {canCreate && (
                <button
                    type="button"
                    className="entity-page-header__action"
                    aria-label={t.crud.createTitle(title)}
                    onClick={() => setEditorOpen(true)}
                >
                    <Icon name="plus" />
                    {t.crud.create}
                </button>
            )}
        </header>
    );

    const controls = type === 'timeline' ? null : (
        <div className="list-controls">
            <SearchInput value={search} label={t.common.search} onChange={(next) => patch({ q: next || null })} />
            {statuses && (
                <div className="filter-chips" role="group" aria-label={t.fields.status}>
                    <button
                        type="button"
                        className={`chip${status === '' ? ' is-active' : ''}`}
                        aria-pressed={status === ''}
                        onClick={() => patch({ status: null })}
                    >
                        {t.common.all}
                    </button>
                    {statuses.map((value) => (
                        <button
                            key={value}
                            type="button"
                            className={`chip${status === value ? ' is-active' : ''}`}
                            aria-pressed={status === value}
                            onClick={() => patch({ status: status === value ? null : value })}
                        >
                            {statusLabel(t, value)}
                        </button>
                    ))}
                </div>
            )}
            {type === 'inventory' && (
                <label className="filter-select">
                    <span>{t.inventory.category}</span>
                    <select
                        value={category}
                        onChange={(event) => patch({ category: event.currentTarget.value || null })}
                    >
                        <option value="">{t.inventory.allCategories}</option>
                        {(Object.keys(CATEGORY_ICONS) as InventoryCategory[]).map((value) => (
                            <option key={value} value={value}>
                                {t.inventory.categories[value]}
                            </option>
                        ))}
                    </select>
                </label>
            )}
        </div>
    );

    if (isLoading) return (<div>{heading}{controls}<Loading /></div>);
    // A background refetch can fail for a few moments during a dev backend
    // restart: if we already have valid data, we do not replace the whole UI.
    if (isError && !data) return (<div>{heading}{controls}<ErrorState error={error} /></div>);

    const rows = data?.items ?? [];
    const total = data?.total ?? 0;
    const columns = columnsFor(type, t, rows[0], locale);
    const idField = ID_FIELD[type];
    const rowId = (row: EntityRow) => String(row[idField] ?? '');
    const pagination = (
        <div className="pagination">
            <button
                disabled={offset === 0}
                onClick={() => patch({ offset: String(Math.max(0, offset - PAGE_SIZE)) }, { resetOffset: false })}
            >
                {t.common.prev}
            </button>
            <span className="pagination-range">{t.common.range(offset + 1, offset + rows.length, total)}</span>
            <button
                disabled={offset + rows.length >= total}
                onClick={() => patch({ offset: String(offset + PAGE_SIZE) }, { resetOffset: false })}
            >
                {t.common.next}
            </button>
        </div>
    );

    return (
        <div
            className={[
                type === 'timeline' ? 'timeline-page' : '',
                isFetching && !isLoading ? 'is-refreshing' : '',
            ].filter(Boolean).join(' ') || undefined}
            aria-busy={isFetching}
        >
            {isFetching && !isLoading && (
                <span className="visually-hidden" role="status" aria-live="polite">
                    {t.common.loading}
                </span>
            )}
            {heading}
            {controls}
            {type === 'quests' && (
                <QuestSuggestionsPanel campaignId={campaignId} enabled={canWrite} />
            )}
            {canWrite && mergeable && selected.size > 0 && (
                <div className="merge-selection-bar" role="status" aria-live="polite">
                    <span className="merge-selection-bar__count">{t.merge.selectedCount(selected.size)}</span>
                    <span className="merge-selection-bar__hint">
                        {selected.size < 2 ? t.merge.selectAtLeastTwo : t.merge.confirmSummary}
                    </span>
                    <button
                        type="button"
                        className="merge-btn merge-btn--ghost"
                        onClick={() => setSelected(new Set())}
                    >
                        {t.merge.clearSelection}
                    </button>
                    <button
                        type="button"
                        className="merge-btn merge-btn--primary"
                        onClick={() => setMergeOpen(true)}
                        disabled={selected.size < 2}
                    >
                        {t.merge.mergeSelected(selected.size)}
                    </button>
                </div>
            )}

            {rows.length === 0 ? (
                <Empty />
            ) : type === 'timeline' ? (
                <>
                    <WorldTimeline items={rows} base={`/guilds/${guildId}/campaigns/${campaignId}`} />
                    {pagination}
                </>
            ) : (
                <>
                    <DataTable
                        columns={columns}
                        rows={rows}
                        caption={title}
                        rowKey={rowId}
                        href={(row) =>
                            rowId(row) ? `/guilds/${guildId}/campaigns/${campaignId}/${entityType}/${rowId(row)}` : ''
                        }
                        sort={{
                            key: sortKey,
                            direction,
                            // Clicking the active column flips it; a new column starts ascending.
                            onSort: (key) =>
                                patch({
                                    sort: key,
                                    dir: key === sortKey && direction === 'asc' ? 'desc' : 'asc',
                                }),
                        }}
                        {...(canWrite && mergeable
                            ? {
                                selected,
                                onToggleSelect: toggleSelect,
                                onToggleSelectAll: toggleSelectAll,
                                isRowSelectable: (row: EntityRow) => type !== 'factions' || row.is_party !== 1,
                                selectLabel: (row: EntityRow) => t.merge.selectRecord(String(row.name ?? row.short_id ?? '')),
                                selectAllLabel: t.merge.selectPage,
                            }
                            : {})}
                    />

                    {pagination}
                </>
            )}

            {canWrite && mergeable && (
                <MergeDuplicatesModal
                    open={mergeOpen}
                    onClose={(completed = false) => {
                        setMergeOpen(false);
                        if (completed) setSelected(new Set());
                    }}
                    campaignId={campaignId}
                    guildId={guildId}
                    entityType={type as 'artifacts' | 'npcs' | 'factions'}
                    selectedShortIds={selectedShortIds}
                />
            )}
            {canCreate && (
                <EntityEditorModal
                    open={editorOpen}
                    onClose={() => setEditorOpen(false)}
                    campaignId={campaignId}
                    entityType={type}
                    entityLabel={title}
                />
            )}
        </div>
    );
}
