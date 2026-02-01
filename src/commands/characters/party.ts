/**
 * $party / $compagni command - Show all party members
 */

import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ComponentType, MessageComponentInteraction } from 'discord.js';
import { Command, CommandContext } from '../types';
import { getCampaignCharacters, getUserProfile, getCharacterUserId, getPartyFaction } from '../../db';

export const partyCommand: Command = {
    name: 'party',
    aliases: ['compagni'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const characters = getCampaignCharacters(ctx.activeCampaign!.id);

        if (characters.length === 0) {
            await ctx.message.reply("Nessun avventuriero registrato in questa campagna.");
            return;
        }

        const list = characters.map(c => {
            const name = c.character_name || "Sconosciuto";
            const details = [c.race, c.class].filter(Boolean).join(' - ');
            return `**${name}**${details ? ` (${details})` : ''}`;
        }).join('\n');

        const alignMoral = ctx.activeCampaign!.party_alignment_moral || "NEUTRALE";
        const alignEthical = ctx.activeCampaign!.party_alignment_ethical || "NEUTRALE";

        // Recupera il nome del party se esiste una fazione associata
        const partyFaction = getPartyFaction(ctx.activeCampaign!.id);
        const partyName = partyFaction ? partyFaction.name : ctx.activeCampaign!.name;

        const embed = new EmbedBuilder()
            .setTitle(`🛡️ Party: ${partyName}`)
            .setColor("#9B59B6")
            .setDescription(list)
            .addFields({
                name: "⚖️ Allineamento del Gruppo",
                value: `**${alignEthical} ${alignMoral}**\n*(E: ${ctx.activeCampaign!.party_ethical_score ?? 0}, M: ${ctx.activeCampaign!.party_moral_score ?? 0})*`,
                inline: false
            });

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('select_party_member')
            .setPlaceholder('🔍 Seleziona un compagno per il profilo...')
            .addOptions(
                characters.map(c =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(c.character_name || "Sconosciuto")
                        .setDescription([c.race, c.class].filter(Boolean).join(' - ') || 'Nessun dettaglio')
                        .setValue(c.character_name || "Sconosciuto")
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
                await interaction.reply({ content: "Solo chi ha invocato il comando può interagire.", ephemeral: true });
                return;
            }

            if (interaction.isStringSelectMenu() && interaction.customId === 'select_party_member') {
                const selectedName = interaction.values[0];
                const userId = getCharacterUserId(ctx.activeCampaign!.id, selectedName);

                if (userId) {
                    const p = getUserProfile(userId, ctx.activeCampaign!.id);

                    const truncate = (text: string, max: number = 1020) => {
                        if (!text || text.length === 0) return "Nessuna descrizione.";
                        return text.length > max ? text.slice(0, max - 3) + '...' : text;
                    };

                    const profileEmbed = new EmbedBuilder()
                        .setTitle(`👤 Profilo di ${p.character_name}`)
                        .setDescription(truncate(p.description || "", 4000))
                        .setColor("#3498DB")
                        .addFields(
                            { name: "🛡️ Classe", value: p.class || "Sconosciuta", inline: true },
                            { name: "🧬 Razza", value: p.race || "Sconosciuta", inline: true },
                            { name: "🌍 Campagna", value: ctx.activeCampaign!.name || "Nessuna", inline: true }
                        );

                    if (p.alignment_moral || p.alignment_ethical) {
                        const scoreText = (p.moral_score !== undefined || p.ethical_score !== undefined)
                            ? `\n*(E: ${p.ethical_score ?? 0}, M: ${p.moral_score ?? 0})*`
                            : '';

                        profileEmbed.addFields({
                            name: "⚖️ Allineamento",
                            value: `${p.alignment_ethical || 'NEUTRALE'} ${p.alignment_moral || 'NEUTRALE'}${scoreText}`,
                            inline: true
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
                    await interaction.reply({ content: "Personaggio non trovato.", ephemeral: true });
                }
            }
        });

        collector.on('end', () => {
            reply.edit({ components: [] }).catch(() => { });
        });
    }
};
