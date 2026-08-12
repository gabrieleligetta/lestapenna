import { db } from '../client';

export type CampaignRole = 'MASTER' | 'PLAYER';

export interface CampaignMember {
    campaign_id: number;
    user_id: string;
    role: CampaignRole;
    added_at: number | null;
}

/**
 * Who belongs to a campaign and in which role.
 *
 * Deliberately distinct from `characters`: a master may have no PC, and access
 * must be revocable without deleting the character (which is narrative content,
 * not a permission).
 */
export const campaignMemberRepository = {
    getRole: (campaignId: number, userId: string): CampaignRole | null => {
        const row = db.prepare(
            'SELECT role FROM campaign_members WHERE campaign_id = ? AND user_id = ?',
        ).get(campaignId, userId) as { role: CampaignRole } | undefined;
        return row?.role ?? null;
    },

    list: (campaignId: number): CampaignMember[] => {
        return db.prepare(`
            SELECT campaign_id, user_id, role, added_at
            FROM campaign_members WHERE campaign_id = ?
            ORDER BY role DESC, added_at ASC
        `).all(campaignId) as CampaignMember[];
    },

    /**
     * Adds or updates a member.
     *
     * A promotion to MASTER is never undone by a later upsert to PLAYER:
     * `$iam <name>` gets re-run often just to change the character's name, and
     * must not demote someone who has been promoted in the meantime.
     */
    upsert: (campaignId: number, userId: string, role: CampaignRole = 'PLAYER'): void => {
        db.prepare(`
            INSERT INTO campaign_members (campaign_id, user_id, role, added_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(campaign_id, user_id) DO UPDATE SET
                role = CASE WHEN campaign_members.role = 'MASTER' THEN 'MASTER' ELSE excluded.role END
        `).run(campaignId, userId, role, Date.now());
    },

    /** Changes the role explicitly, promotions and demotions alike. */
    setRole: (campaignId: number, userId: string, role: CampaignRole): boolean => {
        return db.prepare(
            'UPDATE campaign_members SET role = ? WHERE campaign_id = ? AND user_id = ?',
        ).run(role, campaignId, userId).changes > 0;
    },

    remove: (campaignId: number, userId: string): boolean => {
        return db.prepare(
            'DELETE FROM campaign_members WHERE campaign_id = ? AND user_id = ?',
        ).run(campaignId, userId).changes > 0;
    },

    countMasters: (campaignId: number): number => {
        const row = db.prepare(
            "SELECT COUNT(*) AS count FROM campaign_members WHERE campaign_id = ? AND role = 'MASTER'",
        ).get(campaignId) as { count: number };
        return row.count;
    },
};
