/**
 * $miadesc / $mydesc command - Set character description
 */

import { Command, CommandContext } from '../types';
import { addCharacterEvent, getUserProfile, getCharacterUserId } from '../../db';
import { syncCharacterIfNeeded } from '../../bard';

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

        const userId = ctx.message.author.id;
        const campaignId = ctx.activeCampaign!.id;

        const profile = getUserProfile(userId, campaignId);
        if (!profile || !profile.character_name) {
            await ctx.message.reply("Non hai un personaggio registrato in questa campagna.");
            return;
        }

        // 1. Add Event
        const eventDesc = `[NOTA GIOCATORE] ${val}`;
        addCharacterEvent(campaignId, profile.character_name, 'MANUAL_UPDATE', eventDesc, 'USER_BIO_UPDATE');

        // 2. Trigger Regen
        const msg = await ctx.message.reply(`📝 Nota registrata! Il Bardo sta aggiornando la tua biografia...`);

        await syncCharacterIfNeeded(campaignId, userId, true);

        await msg.edit(`✅ Biografia di **${profile.character_name}** aggiornata con le nuove note.`);
    }
};
