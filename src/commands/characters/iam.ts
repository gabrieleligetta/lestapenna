/**
 * $sono / $iam command - Set character name
 */

import { Command, CommandContext } from '../types';
import { updateUserCharacter } from '../../db';

export const iamCommand: Command = {
    name: 'iam',
    aliases: ['sono'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const val = ctx.args.join(' ');
        if (!val) {
            await ctx.message.reply("Uso: `$sono Nome`");
            return;
        }

        if (val.toUpperCase() === 'DM' || val.toUpperCase() === 'DUNGEON MASTER') {
            updateUserCharacter(ctx.message.author.id, ctx.activeCampaign!.id, 'character_name', 'DM');
            updateUserCharacter(ctx.message.author.id, ctx.activeCampaign!.id, 'class', 'Dungeon Master');
            updateUserCharacter(ctx.message.author.id, ctx.activeCampaign!.id, 'race', 'Narratore');
            await ctx.message.reply(`🎲 **Saluti, Dungeon Master.** Il Bardo è ai tuoi ordini per la campagna **${ctx.activeCampaign!.name}**.`);
        } else {
            updateUserCharacter(ctx.message.author.id, ctx.activeCampaign!.id, 'character_name', val);
            await ctx.message.reply(`⚔️ Nome aggiornato: **${val}** (Campagna: ${ctx.activeCampaign!.name})`);
        }
    }
};
