import { randomUUID as uuidv4 } from 'crypto';
import { wipeDatabase } from '../../../src/db/maintenance';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { characterRepository } from '../../../src/db/repositories/CharacterRepository';
import { campaignMemberRepository } from '../../../src/db/repositories/CampaignMemberRepository';
import {
    canManageMembership,
    canWriteCampaign,
    ensureMembership,
    getCampaignRole,
} from '../../../src/services/campaignAccess';
import { db } from '../../../src/db';

const GUILD = 'test_membership';
let campaignId: number;

const NOT_ADMIN = { guildCanManage: false };
const ADMIN = { guildCanManage: true };

beforeEach(() => {
    wipeDatabase();
    campaignId = campaignRepository.createCampaign(GUILD, `Campaign ${uuidv4()}`);
});

describe('Campaign membership', () => {
    it('denies writes to someone who is not a member', () => {
        expect(getCampaignRole(campaignId, 'stranger')).toBeNull();
        expect(canWriteCampaign(campaignId, 'stranger', NOT_ADMIN)).toBe(false);
    });

    it('lets any member write, master or player alike', () => {
        ensureMembership(campaignId, 'player-1');
        ensureMembership(campaignId, 'master-1', 'MASTER');

        expect(canWriteCampaign(campaignId, 'player-1', NOT_ADMIN)).toBe(true);
        expect(canWriteCampaign(campaignId, 'master-1', NOT_ADMIN)).toBe(true);
    });

    it('keeps the server administrator in, as a lockout valve', () => {
        // No registered member: without this way out, a server with an empty
        // members table would stay locked out of its own campaign.
        expect(canWriteCampaign(campaignId, 'owner', ADMIN)).toBe(true);
        expect(canManageMembership(campaignId, 'owner', ADMIN)).toBe(true);
    });

    it('reserves membership management to masters', () => {
        ensureMembership(campaignId, 'player-1');
        ensureMembership(campaignId, 'master-1', 'MASTER');

        // Otherwise a player could remove the master and be left alone.
        expect(canManageMembership(campaignId, 'player-1', NOT_ADMIN)).toBe(false);
        expect(canManageMembership(campaignId, 'master-1', NOT_ADMIN)).toBe(true);
    });

    it('never demotes a master through a repeated player upsert', () => {
        ensureMembership(campaignId, 'master-1', 'MASTER');
        // `$iam <name>` is re-run every time the character's name changes.
        ensureMembership(campaignId, 'master-1', 'PLAYER');

        expect(getCampaignRole(campaignId, 'master-1')).toBe('MASTER');
    });

    it('supports explicit promotion and removal', () => {
        ensureMembership(campaignId, 'player-1');
        expect(campaignMemberRepository.setRole(campaignId, 'player-1', 'MASTER')).toBe(true);
        expect(getCampaignRole(campaignId, 'player-1')).toBe('MASTER');
        expect(campaignMemberRepository.countMasters(campaignId)).toBe(1);

        expect(campaignMemberRepository.remove(campaignId, 'player-1')).toBe(true);
        expect(canWriteCampaign(campaignId, 'player-1', NOT_ADMIN)).toBe(false);
    });

    it('drops the membership with its campaign', () => {
        ensureMembership(campaignId, 'player-1');
        campaignRepository.deleteCampaign(campaignId);

        expect(
            db.prepare('SELECT COUNT(*) c FROM campaign_members WHERE campaign_id = ?').get(campaignId),
        ).toEqual({ c: 0 });
    });
});

describe('Membership backfill from characters', () => {
    it('enrolls existing characters, promoting the $iam DM convention', () => {
        // Simulates a pre-migration DB: characters with no membership rows.
        characterRepository.updateUserCharacter('pc-1', campaignId, 'character_name', 'Aria');
        characterRepository.updateUserCharacter('dm-1', campaignId, 'character_name', 'DM');
        db.prepare('DELETE FROM campaign_members WHERE campaign_id = ?').run(campaignId);

        db.exec(`INSERT OR IGNORE INTO campaign_members (campaign_id, user_id, role, added_at)
            SELECT campaign_id, user_id,
                   CASE WHEN upper(COALESCE(character_name, '')) = 'DM' THEN 'MASTER' ELSE 'PLAYER' END,
                   strftime('%s', 'now') * 1000
            FROM characters`);

        expect(getCampaignRole(campaignId, 'pc-1')).toBe('PLAYER');
        expect(getCampaignRole(campaignId, 'dm-1')).toBe('MASTER');
    });
});
