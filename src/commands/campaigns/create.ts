/**
 * $creacampagna / $createcampaign command - Create a new campaign
 */

import { Command, CommandContext } from '../types';
import { createCampaign, factionRepository, getCampaigns } from '../../db';

export const createCampaignCommand: Command = {
    name: 'createcampaign',
    aliases: ['creacampagna'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const name = ctx.args.join(' ');
        if (!name) {
            await ctx.message.reply("Uso: `$creacampagna <Nome Campagna>`");
            return;
        }

        createCampaign(ctx.guildId, name);

        // 🆕 Create default party faction for the new campaign
        const campaigns = getCampaigns(ctx.guildId);
        const campaign = campaigns.find(c => c.name === name);
        if (campaign) {
            factionRepository.createPartyFaction(campaign.id);
        }

        await ctx.message.reply(`✅ Campagna **${name}** creata! Usa \`$selezionacampagna ${name}\` per attivarla.`);
    }
};
