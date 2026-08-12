import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
    useEntityDetail,
    useEntityEvents,
    useCampaignPermissions,
    useEntityMutations,
    useMe,
    useTimelineEventDetail,
} from '../api/hooks';
import { useLocale, useT } from '../i18n';
import type { Messages } from '../i18n/messages';
import type {
    CrudEntityType,
    EntityRow,
    EntityType,
    EventedEntityType,
    HistoryEvent,
} from '../api/types';
import { isCrudEntityType } from '../api/types';
import { HIDDEN_DETAIL_FIELDS, formatCellValue } from './entityConfig';
import { Empty, ErrorState, Loading } from '../components/StateViews';
import { FieldList } from '../components/FieldList';
import { EventList } from '../components/EventList';
import { FactionDetailView } from './detail/FactionDetailView';
import { CharacterDetailView, LocationDetailView, NpcDetailView } from './detail/EntityDetailViews';
import { SessionDetailView } from './detail/SessionDetailView';
import { StatusBadge } from '../components/StatusBadge';
import { ArtifactDetailView } from './detail/ArtifactDetailView';
import { Icon } from '../components/icons';
import { WorldTimeline } from '../components/WorldTimeline';
import { InventoryDetailView } from './detail/InventoryDetailView';
import { QuestDetailView } from './detail/QuestDetailView';
import { ConfirmModal } from '../components/ConfirmModal';
import { EntityAdminBar } from '../components/EntityAdminBar';
import { EntityDetailHeader } from '../components/EntityDetailHeader';
import { EventEditorModal } from '../components/EventEditorModal';
import { FragmentsPanel } from '../components/FragmentsPanel';

const EVENTS_PAGE_SIZE = 25;

/**
 * The families whose history carries an alignment weight: they are the only three
 * `*_history` tables with moral_weight/ethical_weight (see schema.ts).
 */
const WEIGHTED_HISTORY: ReadonlySet<string> = new Set(['npcs', 'factions', 'characters']);

/**
 * The last place that still labels a value with its DB column name. The detail
 * endpoints return whole rows, so there is nothing better to use until Fase 2
 * gives each type its own view; the list tables no longer do this.
 */
const GENERIC_FIELD_LABELS: Record<string, keyof Messages['fields']> = {
    short_id: 'id',
    name: 'name',
    item_name: 'item',
    title: 'title',
    type: 'type',
    event_type: 'type',
    race: 'race',
    class: 'class',
    status: 'status',
    role: 'role',
    macro_location: 'region',
    location_macro: 'region',
    micro_location: 'place',
    location_micro: 'place',
    quantity: 'quantity',
    count: 'count',
    description: 'description',
    effects: 'effects',
    is_cursed: 'curse',
    curse_description: 'curse',
    owner_name: 'owner',
    abilities: 'abilities',
    weaknesses: 'weaknesses',
    resistances: 'resistances',
    notes: 'notes',
    variants: 'variants',
    acquired_at: 'acquired',
    last_seen: 'lastSeen',
    session_id: 'session',
    last_updated: 'updated',
    timestamp: 'updated',
};

function humanizeField(key: string): string {
    return key
        .replaceAll('_', ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function GenericFields({ row }: { row: EntityRow }) {
    const t = useT();
    const { locale } = useLocale();
    const fields = Object.entries(row)
        .filter(([key]) => !HIDDEN_DETAIL_FIELDS.has(key))
        .map(([key, value]) => ({
            key,
            label:
                key === 'year'
                    ? t.overview.year
                    : GENERIC_FIELD_LABELS[key]
                      ? t.fields[GENERIC_FIELD_LABELS[key]]
                      : humanizeField(key),
            value:
                key === 'status'
                    ? <StatusBadge status={value == null ? null : String(value)} />
                    : key === 'is_cursed'
                    ? Number(value) === 1
                        ? t.common.yes
                        : t.common.no
                    : formatCellValue(value, key, locale),
            layout: ['description', 'effects', 'curse_description', 'notes'].includes(key)
                ? 'prose' as const
                : 'metadata' as const,
        }))
        .filter((field) => field.value !== '—');
    return <FieldList fields={fields} />;
}

/**
 * The history feed, with in-place correction when the viewer can manage the
 * campaign.
 *
 * Editing lives here rather than in each detail view because the paging state
 * is here: an edit has to land on the page the user is actually looking at.
 */
function EventsList({
    campaignId,
    entityType,
    entityId,
    canWrite,
}: {
    campaignId: string;
    entityType: EventedEntityType;
    entityId: string;
    canWrite: boolean;
}) {
    const [offset, setOffset] = useState(0);
    const [editing, setEditing] = useState<HistoryEvent | null>(null);
    const [deleting, setDeleting] = useState<HistoryEvent | null>(null);
    const t = useT();
    const { data, isLoading, isError, error, refetch } = useEntityEvents(campaignId, entityType, entityId, {
        limit: EVENTS_PAGE_SIZE,
        offset,
    });
    // Characters have no CRUD (they are born from a Discord user), so their
    // history stays read-only even for a manager.
    const editable = canWrite && isCrudEntityType(entityType);
    const crudType = editable ? entityType : null;
    const { deleteEvent, busy, error: mutationError, setError } = useEntityMutations(
        campaignId,
        (crudType ?? 'npcs') as CrudEntityType,
    );

    if (isLoading) return <Loading />;
    if (isError) return <ErrorState error={error} />;

    const events = data?.items ?? [];
    const total = data?.total ?? 0;
    if (events.length === 0) return offset === 0 ? <Empty /> : null;

    async function confirmDeleteEvent() {
        if (!deleting || !crudType) return;
        const done = await deleteEvent(entityId, deleting.id);
        if (done !== null) {
            setDeleting(null);
            await refetch();
        }
    }

    return (
        <div>
            {/* Newest first, as the bot shows them. */}
            <EventList
                events={events}
                actions={
                    crudType
                        ? {
                            onEdit: (event) => setEditing(event),
                            onDelete: (event) => {
                                setError(null);
                                setDeleting(event);
                            },
                        }
                        : undefined
                }
            />
            <div className="pagination">
                <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - EVENTS_PAGE_SIZE))}>
                    {t.common.prev}
                </button>
                <span className="pagination-range">{t.common.range(offset + 1, offset + events.length, total)}</span>
                <button
                    disabled={offset + events.length >= total}
                    onClick={() => setOffset(offset + EVENTS_PAGE_SIZE)}
                >
                    {t.common.next}
                </button>
            </div>

            {crudType && (
                <>
                    <EventEditorModal
                        open={editing !== null}
                        onClose={(saved) => {
                            setEditing(null);
                            if (saved) void refetch();
                        }}
                        campaignId={campaignId}
                        entityType={crudType}
                        entityId={entityId}
                        event={editing}
                        weighted={WEIGHTED_HISTORY.has(entityType)}
                    />
                    <ConfirmModal
                        open={deleting !== null}
                        title={t.events.delete}
                        question={t.events.confirmDelete}
                        busy={busy}
                        error={mutationError}
                        confirmLabel={t.crud.delete}
                        busyLabel={t.crud.deleting}
                        onConfirm={() => void confirmDeleteEvent()}
                        onClose={() => setDeleting(null)}
                    />
                </>
            )}
        </div>
    );
}

function GenericDetailView({ campaignId, entityType, entityId, events }: {
    campaignId: string;
    entityType: EventedEntityType;
    entityId: string;
    events: React.ReactNode;
}) {
    const { data: row, isLoading, isError, error } = useEntityDetail(campaignId, entityType, entityId);

    if (isLoading) return <Loading />;
    if (isError || !row) return <ErrorState error={error} />;

    return (
        <div className="detail-split">
            <div>
                <GenericFields row={row} />
            </div>
            {events}
        </div>
    );
}

function TimelineEventDetailView({ campaignId, shortId, base, actions }: {
    campaignId: string;
    shortId: string;
    base: string;
    actions?: React.ReactNode;
}) {
    const t = useT();
    const { data: event, isLoading, isError, error } = useTimelineEventDetail(campaignId, shortId);

    if (isLoading) return <Loading />;
    if (isError || !event) return <ErrorState error={error} />;

    return (
        <div className="timeline-page">
            <EntityDetailHeader
                kicker={t.entities.timeline}
                title={t.entities.timeline}
                subtitle={t.timeline.subtitle}
                actions={actions}
                media={(
                    <span className="entity-page-header__icon" aria-hidden="true">
                        <Icon name="timeline" />
                    </span>
                )}
            />
            <WorldTimeline items={[event]} base={base} />
        </div>
    );
}

/** The name to show in the delete confirmation, per family. */
function displayName(row: EntityRow | null | undefined, entityType: CrudEntityType): string {
    if (!row) return '';
    if (entityType === 'locations') return `${row.macro_location} — ${row.micro_location}`;
    if (entityType === 'quests') return String(row.title ?? '');
    if (entityType === 'inventory') return String(row.item_name ?? '');
    if (entityType === 'timeline') return String(row.description ?? '').slice(0, 80);
    return String(row.name ?? '');
}

/** The Bardo's memory of this card, which stays below the page. */
function EntityAdmin({
    campaignId,
    entityType,
    entityId,
    canWrite,
}: {
    campaignId: string;
    entityType: CrudEntityType;
    entityId: string;
    canWrite: boolean;
}) {
    return (
        <FragmentsPanel
            campaignId={campaignId}
            entityType={entityType}
            entityId={entityId}
            canWrite={canWrite}
        />
    );
}

/**
 * Edit and delete, for the header to place.
 *
 * They used to sit at the bottom of the page, under the history, in a bar you
 * had to scroll to reach — and in a different spot on every kind of sheet.
 * Where the controls for a thing are should not depend on which kind of thing
 * it is.
 */
function EntityActions({
    campaignId,
    entityType,
    entityId,
    base,
}: {
    campaignId: string;
    entityType: CrudEntityType;
    entityId: string;
    base: string;
}) {
    const t = useT();
    const { data: row } = useEntityDetail(
        campaignId,
        entityType === 'timeline' ? ('timeline' as unknown as EventedEntityType) : entityType,
        entityId,
    );
    const label = entityType in t.entities ? t.entities[entityType as keyof typeof t.entities] : entityType;

    return (
        <EntityAdminBar
            campaignId={campaignId}
            entityType={entityType}
            entityId={entityId}
            entityLabel={label}
            entityName={displayName(row, entityType)}
            row={row}
            listPath={`${base}/${entityType}`}
        />
    );
}

/**
 * Detail views are being migrated one entity type at a time; GenericDetailView
 * is the fallback for the ones not yet converted, so each migration is a small
 * commit that keeps the app working throughout.
 */
export function EntityDetailPage() {
    // The way back is the breadcrumb trail now, so no per-page "← Back" link.
    const { guildId = '', campaignId = '', entityType = '', entityId = '' } = useParams();
    const type = entityType as EntityType;
    const base = `/guilds/${guildId}/campaigns/${campaignId}`;
    const t = useT();
    const { data: me } = useMe();
    // Writing to the campaign is for members of the table: the permission comes
    // from the server, it is not inferred from being a guild administrator.
    const { canWrite } = useCampaignPermissions(campaignId);

    if (type === 'sessions') return <SessionDetailView campaignId={campaignId} base={base} sessionId={entityId} />;

    const admin = isCrudEntityType(type) ? (
        <EntityAdmin
            campaignId={campaignId}
            entityType={type}
            entityId={entityId}
            canWrite={canWrite}
        />
    ) : null;

    if (type === 'timeline') {
        return (
            <div className="entity-detail-page">
                <TimelineEventDetailView
                    campaignId={campaignId}
                    shortId={entityId}
                    base={base}
                    actions={canWrite ? (
                        <EntityActions
                            campaignId={campaignId}
                            entityType="timeline"
                            entityId={entityId}
                            base={base}
                        />
                    ) : null}
                />
                {admin}
            </div>
        );
    }

    const eventedType = type as EventedEntityType;
    const events = (
        <EventsList
            campaignId={campaignId}
            entityType={eventedType}
            entityId={entityId}
            canWrite={canWrite}
        />
    );
    const historyPanel = (
        <section className="detail-history-panel">
            <h2 className="detail-history-title">
                <Icon name="timeline" />
                {t.fields.history}
            </h2>
            {events}
        </section>
    );
    const actions = canWrite && isCrudEntityType(type) ? (
        <EntityActions campaignId={campaignId} entityType={type} entityId={entityId} base={base} />
    ) : null;
    const props = { campaignId, base, entityId, events: historyPanel, canEditImage: canWrite, actions };

    // Artifacts and inventory frame the history in their own layout and
    // receive the bare list; the others get the already headed panel.
    const view =
        type === 'factions' ? <FactionDetailView campaignId={campaignId} base={base} shortId={entityId} events={historyPanel} canWrite={canWrite} actions={actions} />
        : type === 'quests' ? <QuestDetailView campaignId={campaignId} base={base} entityId={entityId} events={historyPanel} canWrite={canWrite} actions={actions} />
        : type === 'npcs' ? <NpcDetailView {...props} />
        : type === 'locations' ? <LocationDetailView {...props} />
        : type === 'characters' ? <CharacterDetailView {...props} canEditImage={canWrite || me?.id === entityId} />
        : type === 'artifacts' ? <ArtifactDetailView campaignId={campaignId} entityId={entityId} events={events} canEditImage={canWrite} actions={actions} />
        : type === 'inventory' ? <InventoryDetailView campaignId={campaignId} base={base} entityId={entityId} events={events} canWrite={canWrite} actions={actions} />
        : <GenericDetailView campaignId={campaignId} entityType={eventedType} entityId={entityId} events={historyPanel} />;

    return (
        <div className="entity-detail-page">
            {view}
            {admin}
        </div>
    );
}
