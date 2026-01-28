/**
 * $bio / $biografia command - Character biography management
 */

import { Command, CommandContext } from '../types';
import { db, updateUserCharacter } from '../../db';
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

        if (firstArg === 'clear' || firstArg === 'svuota' || firstArg === 'empty') {
            const targetName = ctx.args.slice(1).join(' ');

            if (!targetName) {
                // Clear ALL characters
                const characters = db.prepare('SELECT user_id, character_name FROM characters WHERE campaign_id = ?').all(campaignId) as any[];
                if (characters.length === 0) {
                    await ctx.message.reply(`ℹ️ Nessun PG da svuotare.`);
                    return;
                }

                for (const char of characters) {
                    updateUserCharacter(char.user_id, campaignId, 'description', '');
                }

                await ctx.message.reply(`✅ **Biografie svuotate!**\nSvuotati **${characters.length}** personaggi.`);
                return;
            }

            // Clear specific character
            const targetPG = db.prepare('SELECT user_id, character_name FROM characters WHERE campaign_id = ? AND lower(character_name) = lower(?)').get(campaignId, targetName) as any;
            if (!targetPG) {
                await ctx.message.reply(`❌ Non trovo un PG chiamato "**${targetName}**".`);
                return;
            }

            updateUserCharacter(targetPG.user_id, campaignId, 'description', '');
            await ctx.message.reply(`✅ Biografia di **${targetPG.character_name}** svuotata.`);
            return;
        }

        // Help
        await ctx.message.reply(
            "**📜 Gestione Biografie PG**\n\n" +
            "`$bio reset` - Rigenera tutte le biografie (AI)\n" +
            "`$bio reset <Nome>` - Rigenera una biografia (AI)\n" +
            "`$bio clear` - Svuota tutte le biografie\n" +
            "`$bio clear <Nome>` - Svuota una biografia\n\n" +
            "*Le biografie vengono mostrate in `$chisono`/`$whoami`*"
        );
    }
};
