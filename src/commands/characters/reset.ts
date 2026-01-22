/**
 * $resetpg / $clearchara command - Reset character sheet
 */

import { Command, CommandContext } from '../types';
import { deleteUserCharacter } from '../../db';

export const resetCharacterCommand: Command = {
    name: 'clearchara',
    aliases: ['resetpg'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        deleteUserCharacter(ctx.message.author.id, ctx.activeCampaign!.id);
        await ctx.message.reply("🗑️ Scheda personaggio resettata. Ora sei un'anima errante.");
    }
};
