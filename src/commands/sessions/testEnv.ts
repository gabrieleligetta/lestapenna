import { Message } from 'discord.js';
import {
    Campaign,
    getActiveCampaign,
    getCampaigns,
    createCampaign,
    setActiveCampaign,
    setCampaignYear,
    getCampaignLocation,
    updateLocation,
    getUserProfile,
    updateUserCharacter
} from '../../db';
import { getGuildLocale, t } from '../../i18n';

const DEVELOPER_ID = process.env.DISCORD_DEVELOPER_ID;

/**
 * Ensures a test campaign exists and is configured for testing.
 * Sets Year 0, Current proper date, and ensures the user has a character.
 */
export async function ensureTestEnvironment(guildId: string, userId: string, message: Message): Promise<Campaign | null> {
    const locale = getGuildLocale(guildId, message.guild?.preferredLocale);
    // 1. Campaign
    let campaign = getActiveCampaign(guildId);
    let testCampaignName = 'Campagna di Test';

    // When there is no active campaign, look for "Campagna di Test"
    if (!campaign) {
        const campaigns = getCampaigns(guildId);
        let testCampaign = campaigns.find(c => c.name === testCampaignName);

        if (!testCampaign) {
            createCampaign(guildId, testCampaignName);
            testCampaign = getCampaigns(guildId).find(c => c.name === testCampaignName);
            await message.reply(t(locale, 'test.campaignCreated', { name: testCampaignName }));
        }

        if (testCampaign) {
            setActiveCampaign(guildId, testCampaign.id);
            campaign = getActiveCampaign(guildId);
            await message.reply(t(locale, 'test.campaignActive', { name: testCampaignName }));
        }
    }
    // Any other active campaign is left alone: switching away from a real
    // campaign because someone typed $testascolta would move the recording out
    // from under the table without saying so.

    if (!campaign) {
        await message.reply(t(locale, 'test.campaignError'));
        return null;
    }

    // 2. Anno
    if (campaign.current_year === undefined || campaign.current_year === null) {
        setCampaignYear(campaign.id, 1000);
        // Update the local object to reflect the DB
        campaign.current_year = 1000;
        await message.reply(t(locale, 'test.yearSet', { year: 1000 }));
    }

    // 3. Location
    const loc = getCampaignLocation(guildId);
    if (!loc || !loc.macro || !loc.micro) {
        updateLocation(campaign.id, 'Laboratorio', 'Stanza dei Test', undefined, 'SETUP');
        await message.reply(t(locale, 'test.locationSet', { location: 'Laboratorio | Stanza dei Test' }));
    }

    // 4. Registra Developer come DM se è lui
    if (DEVELOPER_ID && userId === DEVELOPER_ID) {
        const devProfile = getUserProfile(userId, campaign.id);
        if (!devProfile.character_name || devProfile.character_name !== 'DM') {
            updateUserCharacter(userId, campaign.id, 'character_name', 'DM');
            updateUserCharacter(userId, campaign.id, 'class', 'Dungeon Master');
            updateUserCharacter(userId, campaign.id, 'race', 'Narratore');
            await message.reply(t(locale, 'test.dmGreeting'));
        }
    } else {
        // 5. Character for ordinary users
        const profile = getUserProfile(userId, campaign.id);
        if (!profile.character_name) {
            updateUserCharacter(userId, campaign.id, 'character_name', 'Test Subject');
            updateUserCharacter(userId, campaign.id, 'class', 'Tester');
            updateUserCharacter(userId, campaign.id, 'race', 'Construct');
            await message.reply(t(locale, 'test.characterCreated', { name: 'Test Subject', details: 'Tester/Construct' }));
        }
    }

    return campaign;
}
