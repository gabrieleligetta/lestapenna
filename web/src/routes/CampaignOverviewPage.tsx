import { Link } from 'react-router-dom';
import { useCampaign } from '../context/CampaignContext';
import { useLocale, useT } from '../i18n';
import { StatTile } from '../components/StatTile';
import arcaneSigil from '../assets/arcane-sigil.svg';
import { Icon } from '../components/icons';
import type { IconName } from '../components/icons';
import { EntityThumbnail } from '../components/EntityMedia';

function sessionDate(timestamp: number): Date {
    return new Date(timestamp < 100_000_000_000 ? timestamp * 1_000 : timestamp);
}

export function CampaignOverviewPage() {
    const { guildId, campaignId, overview } = useCampaign();
    const t = useT();
    const { locale } = useLocale();

    const base = `/guilds/${guildId}/campaigns/${campaignId}`;

    /** Each counter links to the list it counts — a number you cannot click is a dead end. */
    const tiles: Array<{ to: string; value: number; label: string; icon: IconName }> = [
        { to: `${base}/sessions`, value: overview.counts.sessions, label: t.overview.counts.sessions, icon: 'sessions' },
        { to: `${base}/quests`, value: overview.counts.openQuests, label: t.overview.counts.openQuests, icon: 'quests' },
        { to: `${base}/npcs`, value: overview.counts.npcs, label: t.overview.counts.npcs, icon: 'npcs' },
        { to: `${base}/locations`, value: overview.counts.locations, label: t.overview.counts.locations, icon: 'locations' },
        { to: `${base}/factions`, value: overview.counts.factions, label: t.overview.counts.factions, icon: 'factions' },
        { to: `${base}/inventory`, value: overview.counts.inventory, label: t.overview.counts.inventory, icon: 'inventory' },
        { to: `${base}/artifacts`, value: overview.counts.artifacts, label: t.overview.counts.artifacts, icon: 'artifacts' },
        { to: `${base}/bestiary`, value: overview.counts.bestiary, label: t.overview.counts.bestiary, icon: 'bestiary' },
    ];

    return (
        <div className="campaign-overview">
            <header className="campaign-hero">
                <div className="campaign-hero-copy">
                    <span className="campaign-kicker">{t.nav.sections.campaign}</span>
                    <h1>{overview.name}</h1>
                    <div className="campaign-context" aria-label={`${t.overview.year}, ${t.overview.location}`}>
                        <span>
                            <small>{t.overview.year}</small>
                            {overview.currentYear ?? '—'}
                        </span>
                        <span>
                            <small>{t.overview.location}</small>
                            {overview.currentLocation?.macro && overview.currentLocation?.micro
                                ? `${overview.currentLocation.macro} — ${overview.currentLocation.micro}`
                                : '—'}
                        </span>
                    </div>
                </div>

                <div className="campaign-sigil" aria-hidden="true">
                    <img src={arcaneSigil} alt="" />
                </div>
            </header>

            <section className="latest-chronicle" aria-labelledby="latest-chronicle-title">
                <div>
                    <span className="campaign-kicker">{t.overview.lastSession}</span>
                    <h2 id="latest-chronicle-title">
                        {overview.lastSession?.title ?? t.overview.noSession}
                    </h2>
                    {overview.lastSession && (
                        <p className="subtitle">
                            {sessionDate(overview.lastSession.start_time).toLocaleDateString(locale)}
                            {overview.lastSession.session_number ? ` · #${overview.lastSession.session_number}` : ''}
                        </p>
                    )}
                </div>
                {overview.lastSession && (
                    <Link className="arcane-button" to={`${base}/sessions/${overview.lastSession.session_id}`}>
                        {t.nav.seeAll}
                        <Icon name="arrowRight" />
                    </Link>
                )}
            </section>

            <div className="section-head">
                <h2>{t.overview.party}</h2>
                <Link to={`${base}/party`}>{t.nav.seeAll}</Link>
            </div>
            <ul className="party-preview">
                {overview.party.map((member) => (
                    <li key={member.userId}>
                        {member.image ? (
                            <EntityThumbnail image={member.image} icon="characters" shape="portrait" zoomable />
                        ) : (
                            <span className="monogram" aria-hidden="true">
                                {member.name.slice(0, 2).toUpperCase()}
                            </span>
                        )}
                        <Link to={`${base}/characters/${member.userId}`}>{member.name}</Link>
                        {(member.race || member.class) && (
                            <small>{[member.race, member.class].filter(Boolean).join(' · ')}</small>
                        )}
                    </li>
                ))}
            </ul>

            <div className="count-grid">
                {tiles.map((tile) => (
                    <StatTile key={tile.to} to={tile.to} value={tile.value} label={tile.label} icon={tile.icon} />
                ))}
            </div>
        </div>
    );
}
