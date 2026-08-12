/**
 * $chisono / $whoami command - Show character profile
 */

import { EmbedBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import { getUserProfile, getCharacterUserId } from '../../db';
import { formatAlignmentSpectrum, getStoredAlignmentLabel } from '../../utils/alignmentUtils';
import { t } from '../../i18n';

export const whoamiCommand: Command = {
    name: 'whoami',
    category: 'personaggi',
    descriptionKey: 'help.cmd.whoami',
    aliases: ['chisono'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const targetName = ctx.args.join(' ');
        let targetUserId = ctx.message.author.id;
        let targetUser = ctx.message.author;

        if (targetName) {
            const foundId = getCharacterUserId(ctx.activeCampaign!.id, targetName);
            if (!foundId) {
                await ctx.message.reply(t(ctx.locale, 'char.notFoundInParty', { name: targetName }));
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
                if (!text || text.length === 0) return t(ctx.locale, 'char.noDescription');
                return text.length > max ? text.slice(0, max - 3) + '...' : text;
            };

            const embed = new EmbedBuilder()
                .setTitle(t(ctx.locale, 'char.profileTitle', { name: p.character_name }))
                .setDescription(truncate(p.description || "", 4000))
                .setColor("#3498DB")
                .addFields(
                    { name: t(ctx.locale, 'char.fieldClass'), value: p.class || t(ctx.locale, 'char.unknownClass'), inline: true },
                    { name: t(ctx.locale, 'char.fieldRace'), value: p.race || t(ctx.locale, 'char.unknownRace'), inline: true },
                    { name: t(ctx.locale, 'char.fieldCampaign'), value: ctx.activeCampaign!.name || t(ctx.locale, 'char.noCampaign'), inline: true }
                );

            // Add alignment field if available - Visual spectrum
            if (p.alignment_moral || p.alignment_ethical || p.moral_score || p.ethical_score) {
                embed.addFields(
                    {
                        name: t(ctx.locale, 'char.alignChosen'),
                        value: (p.alignment_ethical && p.alignment_moral) ? getStoredAlignmentLabel(ctx.locale, p.alignment_moral, p.alignment_ethical) : t(ctx.locale, 'char.notSet'),
                        inline: false
                    },
                    {
                        name: t(ctx.locale, 'char.alignReal'),
                        value: formatAlignmentSpectrum(ctx.locale, p.moral_score ?? 0, p.ethical_score ?? 0),
                        inline: false
                    }
                );
            }

            if (targetUser && targetUser.id === targetUserId) {
                embed.setThumbnail(targetUser.displayAvatarURL());
            }

            await ctx.message.reply({ embeds: [embed] });
        } else {
            if (targetName) {
                await ctx.message.reply(t(ctx.locale, 'char.incompleteProfile', { name: targetName }));
            } else {
                await ctx.message.reply(t(ctx.locale, 'char.unknownSelf'));
            }
        }
    }
};
