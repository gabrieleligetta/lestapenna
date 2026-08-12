import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client';
import { useEntityDetail } from '../../api/hooks';
import type { InventoryCategory, InventoryDetail } from '../../api/types';
import { Badge } from '../../components/Badge';
import { EntityMedia } from '../../components/EntityMedia';
import { ErrorState, Loading } from '../../components/StateViews';
import { FieldList } from '../../components/FieldList';
import { Icon } from '../../components/icons';
import { InventoryCategoryBadge } from '../../components/InventoryCategoryBadge';
import {
    CATEGORY_ICONS,
    inventoryCategoryOf,
} from '../../components/inventoryPresentation';
import { useLocale, useT } from '../../i18n';
import { EntityDetailHeader } from '../../components/EntityDetailHeader';
import { formatCellValue } from '../entityConfig';

const CATEGORIES = Object.keys(CATEGORY_ICONS) as InventoryCategory[];

export function InventoryDetailView({
    campaignId,
    base,
    entityId,
    events,
    canWrite,
    actions,
}: {
    campaignId: string;
    base: string;
    entityId: string;
    events: React.ReactNode;
    canWrite: boolean;
    actions?: React.ReactNode;
}) {
    const t = useT();
    const { locale } = useLocale();
    const queryClient = useQueryClient();
    const { data: item, isLoading, isError, error } = useEntityDetail<InventoryDetail>(
        campaignId,
        'inventory',
        entityId,
    );
    const [category, setCategory] = useState<InventoryCategory>('OTHER');
    const [saving, setSaving] = useState(false);
    const [feedback, setFeedback] = useState<string | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);

    useEffect(() => {
        setCategory(inventoryCategoryOf(item?.category));
    }, [item?.category]);

    if (isLoading) return <Loading />;
    if (isError || !item) return <ErrorState error={error} />;

    const normalizedCategory = inventoryCategoryOf(item.category);
    const isArtifact = Boolean(item.is_artifact);
    const isCursed = Boolean(item.is_cursed);

    async function saveCategory(event: FormEvent) {
        event.preventDefault();
        if (saving || category === normalizedCategory) return;
        setSaving(true);
        setFeedback(null);
        setSaveError(null);
        try {
            await apiFetch<InventoryDetail>(
                `/campaigns/${campaignId}/inventory/${encodeURIComponent(entityId)}/category`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ category }),
                },
            );
            await queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId] });
            setFeedback(t.inventory.categorySaved);
        } catch (reason) {
            setSaveError(reason instanceof Error ? reason.message : t.common.error);
        } finally {
            setSaving(false);
        }
    }

    return (
        <article className="inventory-detail">
            <EntityDetailHeader
                className="inventory-detail__header"
                kicker={t.entities.inventory}
                title={item.item_name}
                actions={actions}
                media={(
                    <EntityMedia
                        image={item.image}
                        icon={isArtifact ? 'artifacts' : CATEGORY_ICONS[normalizedCategory]}
                        shape="square"
                    />
                )}
                badges={(
                    <>
                        <InventoryCategoryBadge category={normalizedCategory} />
                        {isArtifact && (
                            <Badge tone="accent">
                                <Icon name="artifacts" className="badge-icon" />
                                {t.inventory.artifact}
                            </Badge>
                        )}
                        {isCursed && (
                            <Badge tone="danger">
                                <Icon name="flame" className="badge-icon" />
                                {t.inventory.cursed}
                            </Badge>
                        )}
                    </>
                )}
            >
                {isArtifact && item.artifact_short_id && (
                    <Link to={`${base}/artifacts/${item.artifact_short_id}`}>
                        {t.inventory.artifact}
                    </Link>
                )}
            </EntityDetailHeader>

            <div className="detail-split">
                <div>
                    {item.description && (
                        <section className="inventory-detail__prose">
                            <h2>{t.fields.description}</h2>
                            <p>{item.description}</p>
                        </section>
                    )}
                    {item.notes && (
                        <section className="inventory-detail__prose">
                            <h2>{t.fields.notes}</h2>
                            <p>{item.notes}</p>
                        </section>
                    )}

                    <FieldList
                        fields={[
                            { key: 'quantity', label: t.fields.quantity, value: item.quantity },
                            {
                                key: 'acquired',
                                label: t.fields.acquired,
                                value: formatCellValue(item.acquired_at, 'acquired_at', locale),
                            },
                            {
                                key: 'updated',
                                label: t.fields.updated,
                                value: formatCellValue(item.last_updated, 'last_updated', locale),
                            },
                            { key: 'id', label: t.fields.id, value: item.short_id },
                        ]}
                    />

                    {canWrite && (
                        <form className="inventory-category-editor" onSubmit={(event) => void saveCategory(event)}>
                            <label>
                                <span>{t.inventory.category}</span>
                                <select
                                    value={category}
                                    onChange={(event) => setCategory(event.currentTarget.value as InventoryCategory)}
                                >
                                    {CATEGORIES.map((value) => (
                                        <option key={value} value={value}>
                                            {t.inventory.categories[value]}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <button
                                type="submit"
                                disabled={saving || category === normalizedCategory}
                            >
                                {t.inventory.saveCategory}
                            </button>
                            <span className="inventory-category-editor__feedback" aria-live="polite">
                                {feedback}
                                {saveError && <span role="alert">{saveError}</span>}
                            </span>
                        </form>
                    )}
                </div>

                <aside className="detail-history-panel">
                    <h2 className="detail-history-title">
                        <Icon name="timeline" />
                        {t.fields.history}
                    </h2>
                    {events}
                </aside>
            </div>
        </article>
    );
}
