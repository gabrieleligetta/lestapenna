/**
 * $creacampagna / $createcampaign command - Create a new campaign
 */

import { Command, CommandContext } from '../types';
import { createCampaign } from '../../db';

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
        await ctx.message.reply(`✅ Campagna **${name}** creata! Usa \`$selezionacampagna ${name}\` per attivarla.`);
    }
};
