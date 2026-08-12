/**
 * The birth of a campaign, once for both interfaces.
 *
 * It used to live only in `$createcampaign`, and the web app had no way of
 * creating one. Worse: the command enrolled nobody in `campaign_members`,
 * so a campaign was born **with no master** and `canManageMembership` only
 * passed thanks to the ManageGuild safety valve. Whoever creates the table is its master.
 */

import { campaignRepository } from '../db/repositories/CampaignRepository';
import { factionRepository } from '../db/repositories/FactionRepository';
import { ensureMembership } from './campaignAccess';
import type { Campaign } from '../db/types';

export interface CreateCampaignInput {
    guildId: string;
    name: string;
    /** Discord id of the creator: they are enrolled as MASTER. */
    creatorUserId: string;
    /** The table's spoken language. On the bot it is asked for later, so it is optional. */
    language?: string | null;
    currentYear?: number | null;
    partyName?: string;
}

/** Name already used in the same guild, compared tolerantly of spaces and case. */
export function findCampaignByName(guildId: string, name: string): Campaign | undefined {
    const wanted = name.trim().toLowerCase();
    return campaignRepository.getCampaigns(guildId).find(c => c.name.trim().toLowerCase() === wanted);
}

export function createCampaignWithParty(input: CreateCampaignInput): Campaign {
    const name = input.name.trim();
    const campaignId = campaignRepository.createCampaign(input.guildId, name);

    factionRepository.createPartyFaction(campaignId, input.partyName?.trim() || undefined);
    ensureMembership(campaignId, input.creatorUserId, 'MASTER');

    if (input.language !== undefined) campaignRepository.setCampaignLanguage(campaignId, input.language);
    if (input.currentYear !== undefined && input.currentYear !== null) {
        campaignRepository.setCampaignYear(campaignId, input.currentYear);
    }

    return campaignRepository.getCampaignById(campaignId)!;
}
