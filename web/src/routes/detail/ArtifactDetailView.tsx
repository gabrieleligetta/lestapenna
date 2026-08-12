import { useEntityDetail } from '../../api/hooks';
import type { ArtifactDetail } from '../../api/types';
import { useT } from '../../i18n';
import { EntityMedia } from '../../components/EntityMedia';
import { ErrorState, Loading } from '../../components/StateViews';
import { Icon } from '../../components/icons';
import { Badge } from '../../components/Badge';
import { StatusBadge } from '../../components/StatusBadge';
import { FieldList } from '../../components/FieldList';
import arcaneSigil from '../../assets/arcane-sigil.svg';
import { EntityMediaManager } from '../../components/EntityMediaManager';
import { EntityProfilePanel } from '../../components/EntityProfilePanel';
import { EntityDetailHeader } from '../../components/EntityDetailHeader';

export function ArtifactDetailView({
    campaignId,
    entityId,
    events,
    canEditImage,
    actions,
}: {
    campaignId: string;
    entityId: string;
    events: React.ReactNode;
    canEditImage: boolean;
    actions?: React.ReactNode;
}) {
    const t = useT();
    const { data: artifact, isLoading, isError, error } = useEntityDetail<ArtifactDetail>(
        campaignId,
        'artifacts',
        entityId,
    );

    if (isLoading) return <Loading />;
    if (isError || !artifact) return <ErrorState error={error} />;

    const isCursed = Number(artifact.is_cursed) === 1;
    const whereabouts = [artifact.location_macro, artifact.location_micro].filter(Boolean).join(' · ');

    return (
        <article className="artifact-detail">
            <EntityDetailHeader
                className="artifact-hero"
                kicker={t.entities.artifacts}
                title={artifact.name}
                actions={actions}
                decoration={<img className="artifact-hero__sigil" src={arcaneSigil} alt="" aria-hidden="true" />}
                media={(
                    <div className="entity-media-stack">
                        <EntityMedia
                            image={artifact.image}
                            icon="artifacts"
                            shape="square"
                            campaignId={campaignId}
                            entityType="artifact"
                            entityId={entityId}
                        />
                    </div>
                )}
                badges={(
                    <>
                        <StatusBadge status={artifact.status} />
                        {isCursed && (
                            <Badge tone="danger">
                                <Icon name="flame" className="badge-icon" />
                                {t.fields.curse}
                            </Badge>
                        )}
                    </>
                )}
            />
            <EntityProfilePanel
                campaignId={campaignId}
                entityType="artifact"
                entityId={entityId}
                canEdit={canEditImage}
            />
            <EntityMediaManager
                campaignId={campaignId}
                entityType="artifact"
                entityId={entityId}
                image={artifact.image}
                canEdit={canEditImage}
            />

            <div className="artifact-layout">
                <div className="artifact-main">
                    {artifact.description && (
                        <section className="artifact-prose">
                            <span className="artifact-section-icon" aria-hidden="true">
                                <Icon name="generic" />
                            </span>
                            <div>
                                <h2>{t.fields.description}</h2>
                                <p>{artifact.description}</p>
                            </div>
                        </section>
                    )}

                    <div className="artifact-aspects">
                        {artifact.effects && (
                            <section className="artifact-aspect artifact-aspect--magic">
                                <Icon name="sparkles" />
                                <h2>{t.fields.effects}</h2>
                                <p>{artifact.effects}</p>
                            </section>
                        )}
                        {isCursed && artifact.curse_description && (
                            <section className="artifact-aspect artifact-aspect--curse">
                                <Icon name="flame" />
                                <h2>{t.fields.curse}</h2>
                                <p>{artifact.curse_description}</p>
                            </section>
                        )}
                    </div>

                    <FieldList
                        fields={[
                            { key: 'owner', label: t.fields.owner, value: artifact.owner_name },
                            { key: 'whereabouts', label: t.overview.location, value: whereabouts || null },
                            { key: 'updated', label: t.fields.updated, value: artifact.last_updated },
                            { key: 'id', label: t.fields.id, value: artifact.short_id },
                        ]}
                    />
                </div>

                <aside className="artifact-history" aria-labelledby="artifact-history-title">
                    <h2 id="artifact-history-title">
                        <Icon name="timeline" />
                        {t.fields.history}
                    </h2>
                    {events}
                </aside>
            </div>
        </article>
    );
}
