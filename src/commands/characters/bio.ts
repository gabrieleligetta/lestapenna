/**
 * $bio / $biografia command - Character biography management
 */

import { Command, CommandContext } from '../types';
import { db } from '../../db';
import { resetAndRegenerateCharacterBio, resetAllCharacterBios } from '../../bard';

export const bioCommand: Command = {
    name: 'bio',
    aliases: ['biografia'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const campaignId = ctx.activeCampaign!.id;
        const firstArg = ctx.args[0]?.toLowerCase();

        if (firstArg === 'reset') {
            const targetName = ctx.args.slice(1).join(' ');

            if (!targetName) {
                // Reset ALL characters
                const loadingMsg = await ctx.message.reply(`🔄 **Reset Biografie PG**\nRigenerazione da zero in corso...`);
                try {
                    const result = await resetAllCharacterBios(campaignId);
                    if (result.reset === 0) {
                        await loadingMsg.edit(`ℹ️ **Nessun PG da resettare.**`);
                    } else {
                        await loadingMsg.edit(
                            `✅ **Biografie Rigenerate!**\n` +
                            `Reset **${result.reset}** personaggi:\n` +
                            result.names.map(n => `• ${n}`).join('\n')
                        );
                    }
                } catch (e: any) {
                    await loadingMsg.edit(`❌ Errore reset: ${e.message}`);
                }
                return;
            }

            // Reset specific character
            const targetPG = db.prepare('SELECT user_id, character_name FROM characters WHERE campaign_id = ? AND lower(character_name) = lower(?)').get(campaignId, targetName) as any;
            if (!targetPG) {
                await ctx.message.reply(`❌ Non trovo un PG chiamato "**${targetName}**".`);
                return;
            }

            const loadingMsg = await ctx.message.reply(`🔄 Reset biografia di **${targetPG.character_name}**...`);
            try {
                const result = await resetAndRegenerateCharacterBio(campaignId, targetPG.user_id);
                if (result !== null) {
                    const preview = result.length > 1500 ? result.substring(0, 1500) + '...' : result;
                    await loadingMsg.edit(`✅ **${targetPG.character_name}** rigenerato da zero!\n\n${preview}`);
                } else {
                    await loadingMsg.edit(`❌ Errore: PG non trovato.`);
                }
            } catch (e: any) {
                await loadingMsg.edit(`❌ Errore: ${e.message}`);
            }
            return;
        }

        // Help
        await ctx.message.reply(
            "**📜 Gestione Biografie PG**\n\n" +
            "`$bio reset` - Rigenera da zero tutte le biografie\n" +
            "`$bio reset <NomePG>` - Rigenera da zero la biografia di un PG\n\n" +
            "*Le biografie vengono mostrate in `$chisono`/`$whoami`*"
        );
    }
};
