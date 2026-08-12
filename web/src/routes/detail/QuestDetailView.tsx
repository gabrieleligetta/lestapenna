import { useEntityDetail } from '../../api/hooks';
import type { QuestDetail } from '../../api/types';
import { Badge } from '../../components/Badge';
import { FieldList } from '../../components/FieldList';
import { Icon } from '../../components/icons';
import { QuestSuggestionsPanel } from '../../components/QuestSuggestionsPanel';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/StateViews';
import { useLocale, useT } from '../../i18n';
import { formatCellValue } from '../entityConfig';
import { EntityDetailHeader } from '../../components/EntityDetailHeader';

/**
 * Edit and delete no longer live here: `EntityAdminBar` provides them, the same
 * bar as every other family. What stays quest-specific is the panel of the AI
 * lifecycle proposals.
 */
export function QuestDetailView({
    campaignId,
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
    const { data: quest, isLoading, isError, error } = useEntityDetail<QuestDetail>(
        campaignId,
        'quests',
        entityId,
    );

    if (isLoading) return <Loading />;
    if (isError || !quest) return <ErrorState error={error} />;

    return (
        <article className="quest-detail">
            <EntityDetailHeader
                className="quest-detail__header"
                kicker={t.entities.quests}
                title={quest.title}
                actions={actions}
                media={<span className="entity-page-header__icon" aria-hidden="true"><Icon name="quests" /></span>}
                badges={(
                    <>
                        <StatusBadge status={quest.status} />
                        <Badge tone="neutral">{t.quests.types[quest.type]}</Badge>
                    </>
                )}
            />

            <QuestSuggestionsPanel campaignId={campaignId} questId={quest.id} enabled={canWrite} />

            <div className="detail-split">
                <div>
                    {quest.description && (
                        <section className="quest-detail__prose">
                            <h2>{t.fields.description}</h2>
                            <p>{quest.description}</p>
                        </section>
                    )}
                    <FieldList fields={[
                        { key: 'created', label: t.quests.created, value: formatCellValue(quest.created_at, 'created_at', locale) },
                        { key: 'updated', label: t.fields.updated, value: formatCellValue(quest.last_updated, 'last_updated', locale) },
                        { key: 'session', label: t.fields.session, value: quest.session_id },
                        { key: 'id', label: t.fields.id, value: quest.short_id },
                    ]} />
                </div>
                {events}
            </div>
        </article>
    );
}
