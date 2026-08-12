import { createContext, useContext } from 'react';
import type { CampaignOverview } from '../api/types';

export interface CampaignContextValue {
    guildId: string;
    campaignId: string;
    overview: CampaignOverview;
}

const CampaignContext = createContext<CampaignContextValue | null>(null);

export const CampaignProvider = CampaignContext.Provider;

/**
 * The campaign every route under /guilds/:guildId/campaigns/:campaignId hangs
 * off. CampaignLayout resolves the loading/error/forbidden states once, so
 * anything below it can treat `overview` as present rather than re-deriving
 * three states per page.
 */
export function useCampaign(): CampaignContextValue {
    const value = useContext(CampaignContext);
    if (!value) throw new Error('useCampaign must be used inside CampaignLayout');
    return value;
}
