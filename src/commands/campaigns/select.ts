/**
 * $selezionacampagna / $selectcampaign command - Select active campaign
 */

import { Command, CommandContext } from '../types';
import { getCampaigns, setActiveCampaign } from '../../db';

export const selectCampaignCommand: Command = {
    name: 'selectcampaign',
    aliases: ['selezionacampagna', 'setcampagna', 'setcampaign'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const nameOrId = ctx.args.join(' ');
        if (!nameOrId) {
            await ctx.message.reply("Uso: `$selezionacampagna <Nome o ID>`");
            return;
        }

        const campaigns = getCampaigns(ctx.guildId);
        const target = campaigns.find(c => c.name.toLowerCase() === nameOrId.toLowerCase() || c.id.toString() === nameOrId);

        if (!target) {
            await ctx.message.reply("⚠️ Campagna non trovata.");
            return;
        }

        setActiveCampaign(ctx.guildId, target.id);
        await ctx.message.reply(`✅ Campagna attiva impostata su: **${target.name}**.`);
    }
};
