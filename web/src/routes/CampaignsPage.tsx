import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useGuild, useGuildCampaigns } from '../api/hooks';
import { useT } from '../i18n';
import { Empty, ErrorState, Loading } from '../components/StateViews';
import { CampaignJournalCarousel } from '../components/CampaignJournalCarousel';
import { CreateCampaignModal } from '../components/CreateCampaignModal';

export function CampaignsPage() {
    const { guildId = '' } = useParams();
    const { data: guild } = useGuild(guildId);
    const { data: campaigns, isLoading, isError, error } = useGuildCampaigns(guildId);
    const navigate = useNavigate();
    const t = useT();
    const [creating, setCreating] = useState(false);

    if (isLoading) return <Loading />;
    if (isError && !campaigns) return <ErrorState error={error} />;

    // Whoever creates the campaign becomes its master: creation lands straight
    // on the new campaign, which is where the work continues.
    const onCreated = (campaignId: number) => {
        setCreating(false);
        navigate(`/guilds/${guildId}/campaigns/${campaignId}`);
    };

    const modal = (
        <CreateCampaignModal
            open={creating}
            guildId={guildId}
            onClose={() => setCreating(false)}
            onCreated={onCreated}
        />
    );

    if (!campaigns || campaigns.length === 0) {
        return (
            <div>
                <h1>
                    {t.campaigns.title} — {guild?.name}
                </h1>
                <Empty message={t.campaigns.empty} />

                {/*
                  * A server with no campaigns has, almost always, no keys and no
                  * transcription engine either: creating a campaign here used to
                  * produce a table that still could not record, and nothing said
                  * so. The guided path is the primary action; creating just the
                  * campaign stays available for whoever already knows.
                  */}
                <p>
                    <Link className="arcane-button" to={`/guilds/${guildId}/setup`}>{t.setup.nav}</Link>
                </p>

                <p>
                    <button type="button" onClick={() => setCreating(true)}>
                        {t.campaignAdmin.emptyCta}
                    </button>
                </p>

                <p className="guild-ai-link">
                    <Link to={`/guilds/${guildId}/ai`}>{t.aiSettings.nav}</Link>
                    {' · '}
                    {/* Next to the keys, because that is where someone goes when
                        they start wondering what this thing holds about them. */}
                    <Link to={`/guilds/${guildId}/privacy`}>{t.privacy.nav}</Link>
                </p>
                {modal}
            </div>
        );
    }

    return (
        <div>
            <div className="page-heading">
                <h1>
                    {t.campaigns.title} — {guild?.name}
                </h1>
                <button type="button" className="primary" onClick={() => setCreating(true)}>
                    {t.campaignAdmin.createCta}
                </button>
            </div>
                <p className="guild-ai-link">
                    {/* It has to be reachable from somewhere: with no keys the
                        table cannot record, so the link sits next to the
                        server's campaigns rather than hidden inside one. */}
                    <Link to={`/guilds/${guildId}/ai`}>{t.aiSettings.nav}</Link>
                    {' · '}
                    {/* Next to the keys, because that is where someone goes when
                        they start wondering what this thing holds about them. */}
                    <Link to={`/guilds/${guildId}/privacy`}>{t.privacy.nav}</Link>
                </p>
            <CampaignJournalCarousel
                campaigns={campaigns}
                guildId={guildId}
                labels={{
                    carousel: t.campaigns.title,
                    previous: t.common.prev,
                    next: t.common.next,
                    active: t.campaigns.active,
                    year: t.overview.year,
                    location: t.overview.location,
                    arcanumName: (arcanum) => t.tarot.arcana[arcanum],
                    coverAlt: (name) => t.tarot.coverAlt(name),
                }}
            />
            {modal}
        </div>
    );
}
