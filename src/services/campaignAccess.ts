/**
 * Who may write to a campaign's game world.
 *
 * A single source for the rule across both interfaces — the same criterion that
 * brought `deleteEntityCascade` into `services/entityDeletion.ts`. The two used
 * to diverge in the worst possible way: the web required the Discord
 * ManageGuild permission (so a player at the table could not fix anything),
 * the bot asked for nothing (so anyone able to write in the command
 * channel could delete).
 *
 * Three levels, of which this module covers the second:
 *  - open: reads, `$iam`, `$help`;
 *  - **member**: CRUD on entities, events and fragments — this file;
 *  - operator: wipe, regenerations, deleting a campaign → `utils/permissions.ts`.
 */

import { campaignMemberRepository, type CampaignRole } from '../db/repositories/CampaignMemberRepository';

export type { CampaignRole };

export interface GuildPrivileges {
    /**
     * The caller has ManageGuild/Administrator on the guild.
     *
     * A safety valve: without it, a server with an empty or wrong members table
     * would stay locked out of its own campaign.
     */
    guildCanManage: boolean;
}

export function getCampaignRole(campaignId: number, userId: string): CampaignRole | null {
    return campaignMemberRepository.getRole(campaignId, userId);
}

/** Create, update and delete on entities, events and fragments. */
export function canWriteCampaign(
    campaignId: number,
    userId: string,
    { guildCanManage }: GuildPrivileges,
): boolean {
    if (guildCanManage) return true;
    return getCampaignRole(campaignId, userId) !== null;
}

/**
 * Adding, promoting or removing members.
 *
 * Reserved for masters: if being a member were enough, a player could remove
 * the master and be left alone at the table.
 */
export function canManageMembership(
    campaignId: number,
    userId: string,
    { guildCanManage }: GuildPrivileges,
): boolean {
    if (guildCanManage) return true;
    return getCampaignRole(campaignId, userId) === 'MASTER';
}

/**
 * Enrolls whoever creates a character. Called by `$iam`: creating a PC in a
 * campaign is the gesture of sitting down at the table.
 */
export function ensureMembership(
    campaignId: number,
    userId: string,
    role: CampaignRole = 'PLAYER',
): void {
    campaignMemberRepository.upsert(campaignId, userId, role);
}
