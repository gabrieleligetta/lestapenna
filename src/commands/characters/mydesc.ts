/**
 * $miadesc / $mydesc command - Set character description
 */

import { Command, CommandContext } from '../types';
import { updateUserCharacter } from '../../db';

export const mydescCommand: Command = {
    name: 'mydesc',
    aliases: ['miadesc'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const val = ctx.args.join(' ');
        if (!val) {
            await ctx.message.reply("Uso: `$miadesc Breve descrizione del carattere o aspetto`");
            return;
        }

        updateUserCharacter(ctx.message.author.id, ctx.activeCampaign!.id, 'description', val);
        await ctx.message.reply(`📜 Descrizione aggiornata! Il Bardo prenderà nota.`);
    }
};
