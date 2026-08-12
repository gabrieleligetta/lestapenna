/**
 * $party / $compagni command - Show all party members
 */

import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ComponentType, MessageComponentInteraction } from 'discord.js';
import { Command, CommandContext } from '../types';
import { getCampaignCharacters, getUserProfile, getCharacterUserId, getPartyFaction } from '../../db';
import { formatAlignmentSpectrum } from '../../utils/alignmentUtils';
import { t } from '../../i18n';

export const partyCommand: Command = {
    name: 'party',
    category: 'personaggi',
    descriptionKey: 'help.cmd.party',
    aliases: ['compagni'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const characters = getCampaignCharacters(ctx.activeCampaign!.id);

        if (characters.length === 0) {
            await ctx.message.reply(t(ctx.locale, 'char.noAdventurers'));
            return;
        }

        const list = characters.map(c => {
            const name = c.character_name || t(ctx.locale, 'char.unknown');
            const details = [c.race, c.class].filter(Boolean).join(' - ');
            return `**${name}**${details ? ` (${details})` : ''}`;
        }).join('\n');

        // Fetch the party name when an associated faction exists
        const partyFaction = getPartyFaction(ctx.activeCampaign!.id);
        const partyName = partyFaction ? partyFaction.name : ctx.activeCampaign!.name;

        // Use stored faction scores (avg of faction_history events, set by addFactionEvent / rebuildAlignment)
        const partyAlignment = {
            moralScore: partyFaction?.moral_score ?? ctx.activeCampaign!.party_moral_score ?? 0,
            ethicalScore: partyFaction?.ethical_score ?? ctx.activeCampaign!.party_ethical_score ?? 0
        };

        const embed = new EmbedBuilder()
            .setTitle(t(ctx.locale, 'char.partyTitle', { name: partyName }))
            .setColor("#9B59B6")
            .setDescription(list)
            .addFields({
                name: t(ctx.locale, 'char.groupAlignment'),
                value: formatAlignmentSpectrum(ctx.locale, partyAlignment.moralScore, partyAlignment.ethicalScore),
                inline: false
            });

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('select_party_member')
            .setPlaceholder(t(ctx.locale, 'char.selectMember'))
            .addOptions(
                characters.map(c =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(c.character_name || t(ctx.locale, 'char.unknown'))
                        .setDescription([c.race, c.class].filter(Boolean).join(' - ') || t(ctx.locale, 'char.noDetails'))
                        .setValue(c.character_name || t(ctx.locale, 'char.unknown'))
                        .setEmoji('👤')
                )
            );

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

        const reply = await ctx.message.reply({
            embeds: [embed],
            components: [row]
        });

        const collector = reply.createMessageComponentCollector({
            componentType: ComponentType.StringSelect,
            time: 60000 * 5 // 5 minutes
        });

        collector.on('collect', async (interaction: MessageComponentInteraction) => {
            if (interaction.user.id !== ctx.message.author.id) {
                await interaction.reply({ content: t(ctx.locale, 'common.onlyInvoker'), ephemeral: true });
                return;
            }

            if (interaction.isStringSelectMenu() && interaction.customId === 'select_party_member') {
                const selectedName = interaction.values[0];
                const userId = getCharacterUserId(ctx.activeCampaign!.id, selectedName);

                if (userId) {
                    const p = getUserProfile(userId, ctx.activeCampaign!.id);

                    const truncate = (text: string, max: number = 1020) => {
                        if (!text || text.length === 0) return t(ctx.locale, 'char.noDescription');
                        return text.length > max ? text.slice(0, max - 3) + '...' : text;
                    };

                    const profileEmbed = new EmbedBuilder()
                        .setTitle(t(ctx.locale, 'char.profileTitle', { name: p.character_name || t(ctx.locale, 'char.unknown') }))
                        .setDescription(truncate(p.description || "", 4000))
                        .setColor("#3498DB")
                        .addFields(
                            { name: t(ctx.locale, 'char.fieldClass'), value: p.class || t(ctx.locale, 'char.unknownClass'), inline: true },
                            { name: t(ctx.locale, 'char.fieldRace'), value: p.race || t(ctx.locale, 'char.unknownRace'), inline: true },
                            { name: t(ctx.locale, 'char.fieldCampaign'), value: ctx.activeCampaign!.name || t(ctx.locale, 'char.noCampaign'), inline: true }
                        );

                    if (p.alignment_moral || p.alignment_ethical || p.moral_score || p.ethical_score) {
                        profileEmbed.addFields({
                            name: t(ctx.locale, 'char.alignReal'),
                            value: formatAlignmentSpectrum(ctx.locale, p.moral_score ?? 0, p.ethical_score ?? 0),
                            inline: false
                        });
                    }

                    try {
                        const targetUser = await ctx.client.users.fetch(userId);
                        if (targetUser) {
                            profileEmbed.setThumbnail(targetUser.displayAvatarURL());
                        }
                    } catch (e) { }

                    await interaction.reply({ embeds: [profileEmbed] });
                } else {
                    await interaction.reply({ content: t(ctx.locale, 'char.charNotFound'), ephemeral: true });
                }
            }
        });

        collector.on('end', () => {
            reply.edit({ components: [] }).catch(() => { });
        });
    }
};
