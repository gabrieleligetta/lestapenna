import { Outlet, useParams } from 'react-router-dom';
import { useCampaignOverview } from '../api/hooks';
import { CampaignProvider } from '../context/CampaignContext';
import { ErrorState, Loading } from '../components/StateViews';

/**
 * Owns the campaign's loading/error/forbidden states so the pages below it do
 * not each repeat them.
 *
 * This used to be CampaignOverviewPage: the overview grid, the eight counters
 * and the tab strip were the parent route, so they redrew above every list and
 * every detail view. They now belong to the overview route alone.
 */
export function CampaignLayout() {
    const { guildId = '', campaignId = '' } = useParams();
    const { data: overview, isLoading, error } = useCampaignOverview(campaignId);

    if (isLoading) return <Loading />;
    // Keep the already loaded overview if a refetch falls inside the brief nodemon
    // restart; the error only stays blocking when there is no cache at all.
    if (!overview) return <ErrorState error={error} />;

    return (
        <CampaignProvider value={{ guildId, campaignId, overview }}>
            <Outlet />
        </CampaignProvider>
    );
}
