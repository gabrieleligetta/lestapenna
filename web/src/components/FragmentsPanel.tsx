import { useState } from 'react';
import { useEntityFragments, useEntityMutations } from '../api/hooks';
import type { CrudEntityType, EntityFragment } from '../api/types';
import { useLocale, useT } from '../i18n';
import { Badge } from './Badge';
import { ConfirmModal } from './ConfirmModal';
import { Icon } from './icons';
import { Empty, ErrorState, Loading } from './StateViews';

/** Past this threshold the fragment starts collapsed: these are long memories. */
const PREVIEW_CHARS = 320;

function FragmentCard({
    fragment,
    canWrite,
    onDelete,
}: {
    fragment: EntityFragment;
    canWrite: boolean;
    onDelete: (fragment: EntityFragment) => void;
}) {
    const t = useT();
    const { locale } = useLocale();
    const [expanded, setExpanded] = useState(false);
    const long = fragment.content.length > PREVIEW_CHARS;
    const body = expanded || !long ? fragment.content : `${fragment.content.slice(0, PREVIEW_CHARS)}…`;

    return (
        <li className="fragment-card">
            <div className="fragment-card__head">
                <Badge tone={fragment.is_entity_snapshot ? 'accent' : 'neutral'}>
                    {fragment.is_entity_snapshot ? t.fragments.snapshot : t.fragments.sessionMemory}
                </Badge>
                <span className="card-meta">
                    {fragment.created_at ? new Date(fragment.created_at).toLocaleString(locale) : '—'}
                </span>
                {fragment.session_id && !fragment.is_entity_snapshot && (
                    <span className="card-meta">{t.fields.session} {fragment.session_id}</span>
                )}
                {canWrite && (
                    <button
                        type="button"
                        className="icon-button icon-button--danger fragment-card__delete"
                        aria-label={t.fragments.delete}
                        title={t.fragments.delete}
                        onClick={() => onDelete(fragment)}
                    >
                        <Icon name="trash" />
                    </button>
                )}
            </div>
            <p className="fragment-card__body">{body}</p>
            {long && (
                <button type="button" className="link-button" onClick={() => setExpanded(!expanded)}>
                    {expanded ? t.fragments.collapse : t.fragments.expand}
                </button>
            )}
        </li>
    );
}

/**
 * The long-term memory the Bardo holds about this entity.
 *
 * It is the only place where these fragments are readable: until now the
 * pipeline wrote them and only semantic search read them, so a wrong answer
 * from the Bardo was neither diagnosable nor fixable.
 * The panel starts closed and loads only when opened — these are long texts
 * that are of no use to someone just looking at the card.
 */
export function FragmentsPanel({
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
    const t = useT();
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState<EntityFragment | null>(null);
    const { data, isLoading, isError, error, refetch } = useEntityFragments(
        campaignId, entityType, entityId, open,
    );
    const { deleteFragment, busy, error: deleteError, setError } = useEntityMutations(campaignId, entityType);

    const fragments = data?.items ?? [];

    async function confirmDelete() {
        if (!pending) return;
        const done = await deleteFragment(entityId, pending.id);
        if (done !== null) {
            setPending(null);
            await refetch();
        }
    }

    return (
        <section className="fragments-panel">
            <h2 className="detail-history-title">
                <Icon name="memory" />
                {t.fragments.title}
                {open && data && <span className="card-meta">{t.fragments.count(data.total)}</span>}
            </h2>
            <p className="fragments-panel__subtitle">{t.fragments.subtitle}</p>

            <button
                type="button"
                className="link-button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                {open ? t.fragments.hide : t.fragments.show}
            </button>

            {open && (
                <>
                    {isLoading && <Loading />}
                    {isError && <ErrorState error={error} />}
                    {!isLoading && !isError && fragments.length === 0 && <Empty />}
                    {fragments.length > 0 && (
                        <ul className="fragment-list">
                            {fragments.map((fragment) => (
                                <FragmentCard
                                    key={fragment.id}
                                    fragment={fragment}
                                    canWrite={canWrite}
                                    onDelete={(target) => {
                                        setError(null);
                                        setPending(target);
                                    }}
                                />
                            ))}
                        </ul>
                    )}
                </>
            )}

            <ConfirmModal
                open={pending !== null}
                title={t.fragments.delete}
                question={t.fragments.confirmDelete}
                consequences={
                    pending?.is_entity_snapshot
                        ? t.fragments.deleteSnapshotWarning
                        : t.fragments.deleteWarning
                }
                busy={busy}
                error={deleteError}
                confirmLabel={t.crud.delete}
                busyLabel={t.crud.deleting}
                onConfirm={() => void confirmDelete()}
                onClose={() => setPending(null)}
            />
        </section>
    );
}
