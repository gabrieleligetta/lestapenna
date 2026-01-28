/**
 * $chisono / $whoami command - Show character profile
 */

import { EmbedBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import { getUserProfile, getCharacterUserId } from '../../db';

export const whoamiCommand: Command = {
    name: 'whoami',
    aliases: ['chisono'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const targetName = ctx.args.join(' ');
        let targetUserId = ctx.message.author.id;
        let targetUser = ctx.message.author;

        if (targetName) {
            const foundId = getCharacterUserId(ctx.activeCampaign!.id, targetName);
            if (!foundId) {
                await ctx.message.reply(`❌ Non ho trovato nessun personaggio chiamato "**${targetName}**" nel party.`);
                return;
            }
            targetUserId = foundId;
            try {
                targetUser = await ctx.client.users.fetch(targetUserId);
            } catch (e) {
                // Fallback if user cannot be fetched
            }
        }

        const p = getUserProfile(targetUserId, ctx.activeCampaign!.id);

        if (p.character_name) {
            // Helper to truncate text (Discord limit: 1024 char per field)
            const truncate = (text: string, max: number = 1020) => {
                if (!text || text.length === 0) return "Nessuna descrizione.";
                return text.length > max ? text.slice(0, max - 3) + '...' : text;
            };

            const embed = new EmbedBuilder()
                .setTitle(`👤 Profilo di ${p.character_name}`)
                .setDescription(truncate(p.description || "", 4000))
                .setColor("#3498DB")
                .addFields(
                    { name: "🛡️ Classe", value: p.class || "Sconosciuta", inline: true },
                    { name: "🧬 Razza", value: p.race || "Sconosciuta", inline: true },
                    { name: "🌍 Campagna", value: ctx.activeCampaign!.name || "Nessuna", inline: true }
                );

            if (targetUser && targetUser.id === targetUserId) {
                embed.setThumbnail(targetUser.displayAvatarURL());
            }

            await ctx.message.reply({ embeds: [embed] });
        } else {
            if (targetName) {
                await ctx.message.reply(`Il personaggio **${targetName}** esiste ma non ha un profilo completo.`);
            } else {
                await ctx.message.reply("Non ti conosco in questa campagna. Usa `$sono <Nome>` per iniziare la tua leggenda!");
            }
        }
    }
};
