import { Link } from 'react-router-dom';
import { useCampaign } from '../context/CampaignContext';
import { useParty } from '../api/hooks';
import { useT } from '../i18n';
import { Empty, ErrorState, Loading } from '../components/StateViews';
import { AlignmentPair } from '../components/AlignmentBar';
import { AlignmentCell } from '../components/AlignmentCell';
import { Badge } from '../components/Badge';
import type { PartyMember } from '../api/types';
import { EntityThumbnail } from '../components/EntityMedia';
import { MyCharacterPanel } from '../components/MyCharacterPanel';

/** Deterministic tint from the name: `characters` stores no avatar hash, and the
 *  web request path should not be calling Discord to find one. */
function monogram(name: string | null): { initials: string; hue: number } {
    const text = (name ?? '?').trim();
    const initials = text
        .split(/\s+/)
        .slice(0, 2)
        .map((word) => word[0] ?? '')
        .join('')
        .toUpperCase();

    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
    return { initials: initials || '?', hue: Math.abs(hash) % 360 };
}

function MemberCard({ member, base }: { member: PartyMember; base: string }) {
    const t = useT();
    const { initials, hue } = monogram(member.name);
    const details = [member.race, member.class].filter(Boolean).join(' · ');

    return (
        <li className="member-card">
            {member.image ? (
                <EntityThumbnail image={member.image} icon="characters" shape="portrait" zoomable />
            ) : (
                <span className="monogram" style={{ background: `hsl(${hue} 45% 82%)`, color: `hsl(${hue} 60% 22%)` }} aria-hidden="true">
                    {initials}
                </span>
            )}
            <div className="member-body">
                <div className="member-head">
                    <Link to={`${base}/characters/${member.userId}`} className="card-title">
                        {member.name ?? member.userId}
                    </Link>
                    {member.role && <Badge tone="neutral">{member.role}</Badge>}
                    {!member.hasBio && <Badge tone="warning">{t.party.noBio}</Badge>}
                </div>
                {details && <div className="card-meta">{details}</div>}
                <AlignmentCell
                    moral={member.alignment.moral.label}
                    ethical={member.alignment.ethical.label}
                />
            </div>
        </li>
    );
}

export function PartyPage() {
    const { guildId, campaignId } = useCampaign();
    const { data: party, isLoading, isError, error } = useParty(campaignId);
    const t = useT();

    if (isLoading) return <Loading />;
    if (isError || !party) return <ErrorState error={error} />;

    const base = `/guilds/${guildId}/campaigns/${campaignId}`;

    return (
        <div>
            <h1>{party.name ?? t.overview.party}</h1>
            <p className="subtitle">
                {party.alignmentSource === 'faction' ? t.party.fromFaction : t.party.fromCampaign}
            </p>

            <section className="party-alignment">
                <h2>{t.party.groupAlignment}</h2>
                <AlignmentPair alignment={party.alignment} />
            </section>

            <h2>{t.party.members}</h2>
            {party.members.length === 0 ? (
                <Empty />
            ) : (
                <ul className="member-list">
                    {party.members.map((member) => (
                        <MemberCard key={member.userId} member={member} base={base} />
                    ))}
                </ul>
            )}

            <MyCharacterPanel campaignId={campaignId} />
        </div>
    );
}
