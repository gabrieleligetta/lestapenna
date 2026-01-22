/**
 * $miaclasse / $myclass command - Set character class
 */

import { Command, CommandContext } from '../types';
import { updateUserCharacter } from '../../db';

export const myclassCommand: Command = {
    name: 'myclass',
    aliases: ['miaclasse'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const val = ctx.args.join(' ');
        if (!val) {
            await ctx.message.reply("Uso: `$miaclasse Barbaro / Mago / Ladro...`");
            return;
        }

        updateUserCharacter(ctx.message.author.id, ctx.activeCampaign!.id, 'class', val);
        await ctx.message.reply(`🛡️ Classe aggiornata: **${val}**`);
    }
};
