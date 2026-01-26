import { db } from '../../../src/db';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { locationRepository } from '../../../src/db/repositories/LocationRepository';
import { sessionRepository } from '../../../src/db/repositories/SessionRepository';
import { wipeDatabase } from '../../../src/db/maintenance';
import { v4 as uuidv4 } from 'uuid';

describe('Complex Persistence Scenario', () => {
    const guildId = 'complex_test_guild';
    let campaignId: number;

    beforeAll(() => {
        wipeDatabase();
        campaignId = campaignRepository.createCampaign(guildId, 'Complex Campaign');
        campaignRepository.setActiveCampaign(guildId, campaignId);
    });

    afterAll(() => {
        wipeDatabase();
    });

    it('should maintain current_year through session creation and location updates', () => {
        // 1. Set Year 0
        campaignRepository.setCampaignYear(campaignId, 0);
        let c = campaignRepository.getActiveCampaign(guildId);
        expect(c!.current_year).toBe(0);

        // 2. Update Location (Repo level)
        locationRepository.updateLocation(campaignId, 'Macro', 'Micro');
        c = campaignRepository.getActiveCampaign(guildId);
        expect(c!.current_year).toBe(0);

        // 3. Create Session
        const sessionId = uuidv4();
        sessionRepository.createSession(sessionId, guildId, campaignId);

        c = campaignRepository.getActiveCampaign(guildId);
        expect(c!.current_year).toBe(0);

        // 4. Update Session Title
        sessionRepository.updateSessionTitle(sessionId, 'Test Session');
        c = campaignRepository.getActiveCampaign(guildId);
        expect(c!.current_year).toBe(0);

        // 5. Add Session Log
        sessionRepository.addSessionLog(sessionId, 'Log content');
        c = campaignRepository.getActiveCampaign(guildId);
        expect(c!.current_year).toBe(0);

        // 6. Simulate "Stop" (no DB helper for stop, but it calls wait...)
        // effectively just verify everything is fine.
    });
});
