import { Link } from 'react-router-dom';
import { useEntityDetail } from '../../api/hooks';
import { useT } from '../../i18n';
import { ErrorState, Loading } from '../../components/StateViews';
import { AlignmentPair } from '../../components/AlignmentBar';
import { Badge } from '../../components/Badge';
import { FieldList } from '../../components/FieldList';
import type { Affiliation, CharacterDetail, LocationDetail, NpcDetail } from '../../api/types';
import { StatusBadge } from '../../components/StatusBadge';
import { EntityMedia } from '../../components/EntityMedia';
import { EntityMediaManager } from '../../components/EntityMediaManager';
import { EntityDetailHeader } from '../../components/EntityDetailHeader';
import { EntityProfilePanel } from '../../components/EntityProfilePanel';

/** Shared by every typed detail view: the entity's memberships, linked to their factions. */
export function Affiliations({ factions, base }: { factions: Affiliation[]; base: string }) {
    const t = useT();
    if (factions.length === 0) return null;

    return (
        <section>
            <h2>{t.entities.factions}</h2>
            <ul className="plain-list">
                {factions.map((affiliation) => (
                    <li key={`${affiliation.factionName}-${affiliation.role}`}>
                        {affiliation.factionShortId ? (
                            <Link to={`${base}/factions/${affiliation.factionShortId}`}>{affiliation.factionName}</Link>
                        ) : (
                            affiliation.factionName
                        )}{' '}
                        <span className="card-meta">{affiliation.role}</span>
                    </li>
                ))}
            </ul>
        </section>
    );
}

/** The alignment section: the shared pair of bars under this view's own heading. */
function AlignmentSection({ alignment }: { alignment: NpcDetail['alignment'] }) {
    const t = useT();
    return (
        <section>
            <h2>{t.fields.alignment}</h2>
            <AlignmentPair alignment={alignment} />
        </section>
    );
}

interface ViewProps {
    campaignId: string;
    base: string;
    entityId: string;
    canEditImage: boolean;
    /** The history feed, rendered by the caller so paging state stays in one place. */
    events: React.ReactNode;
    /** Edit and delete, placed by the shared header rather than by each view. */
    actions?: React.ReactNode;
}

export function NpcDetailView({ campaignId, base, entityId, events, canEditImage, actions }: ViewProps) {
    const t = useT();
    const { data: npc, isLoading, isError, error } = useEntityDetail<NpcDetail>(campaignId, 'npcs', entityId);

    if (isLoading) return <Loading />;
    if (isError || !npc) return <ErrorState error={error} />;

    return (
        <div className="detail-split">
            <div>
                <EntityDetailHeader
                    kicker={t.entities.npcs}
                    title={npc.name}
                    actions={actions}
                    media={(
                        <div className="entity-media-stack">
                            <EntityMedia
                                image={npc.image}
                                icon="npcs"
                                campaignId={campaignId}
                                entityType="npc"
                                entityId={entityId}
                            />
                        </div>
                    )}
                    badges={(
                        <>
                            <StatusBadge status={npc.status} />
                            {npc.role && <Badge tone="neutral">{npc.role}</Badge>}
                        </>
                    )}
                />
                <EntityProfilePanel
                    campaignId={campaignId}
                    entityType="npc"
                    entityId={entityId}
                    canEdit={canEditImage}
                />
                <EntityMediaManager
                    campaignId={campaignId}
                    entityType="npc"
                    entityId={entityId}
                    image={npc.image}
                    canEdit={canEditImage}
                />
                {npc.description && <p>{npc.description}</p>}
                <AlignmentSection alignment={npc.alignment} />
                <Affiliations factions={npc.factions} base={base} />
                <FieldList
                    fields={[
                        { key: 'aliases', label: t.fields.name, value: npc.aliases },
                        { key: 'updated', label: t.fields.updated, value: npc.last_updated },
                    ]}
                />
            </div>
            <div>{events}</div>
        </div>
    );
}

export function LocationDetailView({ campaignId, base, entityId, events, canEditImage, actions }: ViewProps) {
    const t = useT();
    const { data: location, isLoading, isError, error } = useEntityDetail<LocationDetail>(
        campaignId,
        'locations',
        entityId,
    );

    if (isLoading) return <Loading />;
    if (isError || !location) return <ErrorState error={error} />;

    return (
        <div className="detail-split">
            <div>
                <EntityDetailHeader
                    className="entity-detail-header--location"
                    kicker={t.entities.locations}
                    title={location.micro_location}
                    subtitle={location.macro_location}
                    actions={actions}
                    media={(
                        <div className="entity-media-stack entity-media-stack--landscape">
                            <EntityMedia
                                image={location.image}
                                icon="locations"
                                shape="landscape"
                                campaignId={campaignId}
                                entityType="location"
                                entityId={entityId}
                            />
                        </div>
                    )}
                />
                <EntityProfilePanel
                    campaignId={campaignId}
                    entityType="location"
                    entityId={entityId}
                    canEdit={canEditImage}
                />
                <EntityMediaManager
                    campaignId={campaignId}
                    entityType="location"
                    entityId={entityId}
                    image={location.image}
                    canEdit={canEditImage}
                />
                {location.description && <p>{location.description}</p>}
                <Affiliations factions={location.factions} base={base} />
                <FieldList fields={[{ key: 'updated', label: t.fields.updated, value: location.last_updated }]} />
            </div>
            <div>{events}</div>
        </div>
    );
}

export function CharacterDetailView({ campaignId, base, entityId, events, canEditImage, actions }: ViewProps) {
    const t = useT();
    const { data: character, isLoading, isError, error } = useEntityDetail<CharacterDetail>(
        campaignId,
        'characters',
        entityId,
    );

    if (isLoading) return <Loading />;
    if (isError || !character) return <ErrorState error={error} />;

    return (
        <div className="detail-split">
            <div>
                <EntityDetailHeader
                    kicker={t.entities.characters}
                    title={character.character_name}
                    actions={actions}
                    media={(
                        <div className="entity-media-stack">
                            <EntityMedia
                                image={character.image}
                                icon="characters"
                                campaignId={campaignId}
                                entityType="character"
                                entityId={entityId}
                            />
                        </div>
                    )}
                    badges={(
                        <>
                            {character.race && <Badge tone="neutral">{character.race}</Badge>}
                            {character.class && <Badge tone="neutral">{character.class}</Badge>}
                        </>
                    )}
                />
                <EntityProfilePanel
                    campaignId={campaignId}
                    entityType="character"
                    entityId={entityId}
                    canEdit={canEditImage}
                />
                <EntityMediaManager
                    campaignId={campaignId}
                    entityType="character"
                    entityId={entityId}
                    image={character.image}
                    canEdit={canEditImage}
                />
                {character.description && <p>{character.description}</p>}
                <AlignmentSection alignment={character.alignment} />
                <Affiliations factions={character.factions} base={base} />
                <FieldList
                    fields={[
                        // The player-written foundation the AI must not contradict.
                        { key: 'foundation', label: t.fields.description, value: character.foundation_description },
                        // Only ever present when you are looking at your own sheet.
                        { key: 'email', label: 'Email', value: character.email ?? null },
                    ]}
                />
            </div>
            <div>{events}</div>
        </div>
    );
}
