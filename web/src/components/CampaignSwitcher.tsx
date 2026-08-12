import { useNavigate, useParams } from 'react-router-dom';
import { useGuildCampaigns, useGuilds } from '../api/hooks';
import { useT } from '../i18n';

/**
 * Jump between servers and campaigns without walking back up the tree — until
 * now the only way to change campaign was to navigate to /guilds and drill down
 * again.
 *
 * Native <select> on purpose: it is a dropdown that is already keyboard- and
 * screen-reader-correct, and on phones it opens the OS picker.
 */
export function CampaignSwitcher() {
    const { guildId = '', campaignId = '' } = useParams();
    const navigate = useNavigate();
    const t = useT();

    const { data: guilds } = useGuilds();
    const { data: campaigns } = useGuildCampaigns(guildId);

    if (!guildId) return null;

    return (
        <div className="campaign-switcher">
            <label className="visually-hidden" htmlFor="switch-guild">
                {t.nav.servers}
            </label>
            <select
                id="switch-guild"
                value={guildId}
                onChange={(e) => navigate(`/guilds/${e.target.value}/campaigns`)}
            >
                {/* The current guild may not be in the list yet on a deep link. */}
                {!guilds?.some((g) => g.id === guildId) && <option value={guildId}>…</option>}
                {guilds?.map((guild) => (
                    <option key={guild.id} value={guild.id}>
                        {guild.name}
                    </option>
                ))}
            </select>

            {campaignId && (
                <>
                    <label className="visually-hidden" htmlFor="switch-campaign">
                        {t.campaigns.title}
                    </label>
                    <select
                        id="switch-campaign"
                        value={campaignId}
                        onChange={(e) => navigate(`/guilds/${guildId}/campaigns/${e.target.value}`)}
                    >
                        {!campaigns?.some((c) => String(c.id) === campaignId) && <option value={campaignId}>…</option>}
                        {campaigns?.map((campaign) => (
                            <option key={campaign.id} value={campaign.id}>
                                {campaign.name}
                            </option>
                        ))}
                    </select>
                </>
            )}
        </div>
    );
}
