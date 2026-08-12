import { ReferenceImagesPanel } from '../../components/ReferenceImagesPanel';
import { EntityDetailHeader } from '../../components/EntityDetailHeader';
import { Link } from 'react-router-dom';
import { useFactionDetail, useFactionMembers } from '../../api/hooks';
import { useT } from '../../i18n';
import { Empty, ErrorState, Loading } from '../../components/StateViews';
import { AlignmentPair } from '../../components/AlignmentBar';
import { ReputationMeter } from '../../components/ReputationMeter';
import { Badge } from '../../components/Badge';
import { FieldList } from '../../components/FieldList';
import type { FactionMember } from '../../api/types';
import { StatusBadge } from '../../components/StatusBadge';

/** NPCs and locations have their own pages; a PC links to its character sheet. */
function memberHref(member: FactionMember, base: string): string | null {
    if (member.entityType === 'npc' && member.shortId) return `${base}/npcs/${member.shortId}`;
    if (member.entityType === 'location' && member.shortId) return `${base}/locations/${member.shortId}`;
    if (member.entityType === 'pc' && member.userId) return `${base}/characters/${member.userId}`;
    return null;
}

export function FactionDetailView({ campaignId, base, shortId, events, canWrite, actions }: {
    campaignId: string;
    base: string;
    shortId: string;
    /** The faction history: it used to not appear in this view at all. */
    events: React.ReactNode;
    canWrite: boolean;
    actions?: React.ReactNode;
}) {
    const t = useT();
    const { data: faction, isLoading, isError, error } = useFactionDetail(campaignId, shortId);
    const { data: members } = useFactionMembers(campaignId, shortId);

    if (isLoading) return <Loading />;
    if (isError || !faction) return <ErrorState error={error} />;

    return (
        <div className="detail-split">
            <div>
                <EntityDetailHeader
                    kicker={t.entities.factions}
                    title={faction.name}
                    actions={actions}
                    badges={(
                        <>
                            <Badge tone="neutral">{faction.type}</Badge>
                            <StatusBadge status={faction.status} />
                            {faction.is_party === 1 && <Badge tone="accent">{t.overview.party}</Badge>}
                        </>
                    )}
                />

                {faction.description && <p>{faction.description}</p>}

                {/* The party has no standing with itself. */}
                {faction.is_party === 0 && (
                    <section>
                        <h2>{t.reputation.label}</h2>
                        <ReputationMeter level={faction.reputation} />
                    </section>
                )}

                <section>
                    <h2>{t.fields.alignment}</h2>
                    <AlignmentPair alignment={faction.alignment} />
                </section>

                {/* The livery: what a member of this faction is drawn wearing.
                    It lives here because that is where it is described, and no
                    search for a member's own name would ever reach it. */}
                <ReferenceImagesPanel
                    campaignId={campaignId}
                    scope="faction"
                    scopeKey={shortId}
                    canEdit={canWrite}
                />

                <FieldList
                    fields={[
                        { key: 'npcs', label: t.entities.npcs, value: faction.memberCounts.npcs },
                        { key: 'locations', label: t.entities.locations, value: faction.memberCounts.locations },
                        { key: 'pcs', label: t.entities.characters, value: faction.memberCounts.pcs },
                        { key: 'updated', label: t.fields.updated, value: faction.last_updated },
                    ]}
                />
            </div>

            <div>
                <h2>{t.party.members}</h2>
                {members && members.items.length > 0 ? (
                    <ul className="plain-list">
                        {members.items.map((member) => {
                            const href = memberHref(member, base);
                            return (
                                <li key={`${member.entityType}-${member.name}-${member.role}`}>
                                    {/* Members used to render as the literal 'ID:7' for characters. */}
                                    {href ? <Link to={href}>{member.name ?? '—'}</Link> : (member.name ?? '—')}{' '}
                                    <span className="card-meta">{member.role}</span>
                                </li>
                            );
                        })}
                    </ul>
                ) : (
                    <Empty />
                )}
            </div>

            {events}
        </div>
    );
}
