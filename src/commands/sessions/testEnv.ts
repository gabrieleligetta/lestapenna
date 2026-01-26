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

const DEVELOPER_ID = process.env.DISCORD_DEVELOPER_ID;

/**
 * Ensures a test campaign exists and is configured for testing.
 * Sets Year 0, Current proper date, and ensures the user has a character.
 */
export async function ensureTestEnvironment(guildId: string, userId: string, message: Message): Promise<Campaign | null> {
    // 1. Campagna
    let campaign = getActiveCampaign(guildId);
    let testCampaignName = 'Campagna di Test';

    // Se non c'è campagna attiva, cerca "Campagna di Test"
    if (!campaign) {
        const campaigns = getCampaigns(guildId);
        let testCampaign = campaigns.find(c => c.name === testCampaignName);

        if (!testCampaign) {
            createCampaign(guildId, testCampaignName);
            testCampaign = getCampaigns(guildId).find(c => c.name === testCampaignName);
            await message.reply(`🧪 Creata campagna automatica: **${testCampaignName}**`);
        }

        if (testCampaign) {
            setActiveCampaign(guildId, testCampaign.id);
            campaign = getActiveCampaign(guildId);
            await message.reply(`📋 Campagna attiva impostata su: **${testCampaignName}**`);
        }
    } else if (campaign.name === 'Campagna di Test') {
        // Se è già attiva la campagna di test, usiamo quella
    } else {
        // C'è un'altra campagna attiva. Per sicurezza in test mode switchiamo?
        // Il comportamento originale sembrerebbe "se non c'è campagna attiva".
        // Se l'utente fa $testascolta mentre è in una campagna reale, 
        // forse non dovremmo switchare automaticamente per evitare confusione?
        // Manteniamo il comportamento "se non c'è campagna".
        // Se però è "Campagna di Test" ma non configurata, la configuriamo.
    }

    if (!campaign) {
        await message.reply(`❌ Errore critico: Impossibile creare o recuperare la campagna di test.`);
        return null;
    }

    // 2. Anno
    if (campaign.current_year === undefined || campaign.current_year === null) {
        setCampaignYear(campaign.id, 1000);
        // Aggiorniamo l'oggetto locale per riflettere il DB
        campaign.current_year = 1000;
        await message.reply(`📅 Anno impostato a 1000.`);
    }

    // 3. Luogo
    const loc = getCampaignLocation(guildId);
    if (!loc || !loc.macro || !loc.micro) {
        updateLocation(campaign.id, 'Laboratorio', 'Stanza dei Test', undefined, 'SETUP');
        await message.reply(`📍 Luogo impostato: **Laboratorio | Stanza dei Test**`);
    }

    // 4. Registra Developer come DM se è lui
    if (DEVELOPER_ID && userId === DEVELOPER_ID) {
        const devProfile = getUserProfile(userId, campaign.id);
        if (!devProfile.character_name || devProfile.character_name !== 'DM') {
            updateUserCharacter(userId, campaign.id, 'character_name', 'DM');
            updateUserCharacter(userId, campaign.id, 'class', 'Dungeon Master');
            updateUserCharacter(userId, campaign.id, 'race', 'Narratore');
            await message.reply(`🎲 **Saluti, Dungeon Master!** Il Bardo è ai tuoi ordini.`);
        }
    } else {
        // 5. Personaggio per utenti normali
        const profile = getUserProfile(userId, campaign.id);
        if (!profile.character_name) {
            updateUserCharacter(userId, campaign.id, 'character_name', 'Test Subject');
            updateUserCharacter(userId, campaign.id, 'class', 'Tester');
            updateUserCharacter(userId, campaign.id, 'race', 'Construct');
            await message.reply(`🧪 Personaggio creato: **Test Subject** (Tester/Construct)`);
        }
    }

    return campaign;
}
