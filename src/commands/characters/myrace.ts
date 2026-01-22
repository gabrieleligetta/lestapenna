/**
 * $miarazza / $myrace command - Set character race
 */

import { Command, CommandContext } from '../types';
import { updateUserCharacter } from '../../db';

export const myraceCommand: Command = {
    name: 'myrace',
    aliases: ['miarazza'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const val = ctx.args.join(' ');
        if (!val) {
            await ctx.message.reply("Uso: `$miarazza Umano / Elfo / Nano...`");
            return;
        }

        updateUserCharacter(ctx.message.author.id, ctx.activeCampaign!.id, 'race', val);
        await ctx.message.reply(`🧬 Razza aggiornata: **${val}**`);
    }
};
