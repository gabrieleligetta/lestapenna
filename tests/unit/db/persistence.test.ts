import { db } from '../../../src/db';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { wipeDatabase } from '../../../src/db/maintenance';

describe('Data Persistence', () => {
    beforeAll(() => {
        wipeDatabase();
    });

    afterAll(() => {
        wipeDatabase();
    });

    it('should persist current_year across multiple retrievals', () => {
        const guildId = 'test_guild_persistence';
        const campaignName = 'Persistence Campaign';

        // 1. Create Campaign
        const campaignId = campaignRepository.createCampaign(guildId, campaignName);
        campaignRepository.setActiveCampaign(guildId, campaignId);

        let campaign = campaignRepository.getActiveCampaign(guildId);
        expect(campaign).toBeDefined();
        expect(campaign!.current_year).toBeNull(); // Initially null

        // 2. Set Year 0
        campaignRepository.setCampaignYear(campaignId, 0);

        // 3. Retrieve again
        campaign = campaignRepository.getActiveCampaign(guildId);
        expect(campaign!.current_year).toBe(0);

        // 4. Set valid year 100
        campaignRepository.setCampaignYear(campaignId, 100);

        // 5. Retrieve again
        campaign = campaignRepository.getActiveCampaign(guildId);
        expect(campaign!.current_year).toBe(100);
    });

    it('should persist after simulated "restart" (new DB connection if possible, or just fresh query)', () => {
        // Since we can't easily restart the DB connection in a single test file without some hacks,
        // we rely on the fact that getActiveCampaign always runs a NEW SELECT query.

        const guildId = 'test_guild_restart';
        const campaignId = campaignRepository.createCampaign(guildId, 'Restart Campaign');
        campaignRepository.setActiveCampaign(guildId, campaignId);

        campaignRepository.setCampaignYear(campaignId, 200);

        const campaign = campaignRepository.getActiveCampaign(guildId);
        expect(campaign!.id).toBe(campaignId);
        expect(campaign!.current_year).toBe(200);
    });
});
