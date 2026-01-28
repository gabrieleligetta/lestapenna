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

        // 1. Add Event (Marked as MANUAL for persistence)
        const eventDesc = `[NOTA GIOCATORE] ${val}`;
        addCharacterEvent(campaignId, profile.character_name, 'MANUAL_UPDATE', eventDesc, 'USER_BIO_UPDATE', true);

        // 2. Update Foundation Description (Permanent base for bios)
        const { characterRepository } = await import('../../db');
        characterRepository.updateFoundationDescription(userId, campaignId, val);

        // 3. Trigger Regen
        const msg = await ctx.message.reply(`📝 Nota registrata come base della tua biografia! Il Bardo sta aggiornando il tuo profilo...`);

        await syncCharacterIfNeeded(campaignId, userId, true);

        await msg.edit(`✅ Biografia di **${profile.character_name}** aggiornata. La tua nota è stata salvata come fondamento narrativo.`);
    }
};
