/**
 * $character / $pg command - Character management and events
 */

import { EmbedBuilder, ActionRowBuilder, ComponentType, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import { characterRepository } from '../../db/repositories/CharacterRepository';
import { showEntityEvents } from '../utils/eventsViewer';
import { handleEventsAction } from '../utils/eventsSubcommand';
import { parseShortId } from '../../utils/shortId';
import { t } from '../../i18n';

export const characterCommand: Command = {
    name: 'character',
    category: 'personaggi',
    descriptionKey: 'help.cmd.character',
    aliases: ['pg', 'personaggio'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const firstArg = ctx.args[0]?.toLowerCase();
        const arg = ctx.args.join(' ');

        // 🆕 Events Subcommand: $character events [action] [Target]
        if (firstArg === 'events' || firstArg === 'eventi') {
            const remainder = ctx.args.slice(1);

            const handled = await handleEventsAction(ctx, remainder, {
                tableName: 'character_history',
                entityKeyColumn: 'character_name',
                emoji: '👤',
                labelKey: 'entity.character',
                resolve: (campaignId, identifier) => {
                    // Exact match by userId, then a loose match over the list
                    let charName: string | null = null;
                    const userId = characterRepository.getCharacterUserId(campaignId, identifier);
                    if (userId) {
                        const profile = characterRepository.getUserProfile(userId, campaignId);
                        if (profile?.character_name) charName = profile.character_name;
                    }
                    if (!charName) {
                        const allChars = characterRepository.getCampaignCharacters(campaignId);
                        const match = allChars.find(c => c.character_name?.toLowerCase().includes(identifier.toLowerCase()));
                        if (match) charName = match.character_name;
                    }
                    return charName ? { keyValue: charName, displayName: charName } : null;
                }
            });
            if (handled) return;

            const target = remainder.join(' ').trim().toLowerCase();

            if (remainder.length === 0 || target === 'list' || target === 'lista') {
                await startCharacterEventsInteractiveSelection(ctx);
                return;
            }

            // Try to parse page number
            let page = 1;
            let charTarget = remainder.join(' ');
            const lastArg = remainder[remainder.length - 1];
            if (remainder.length > 1 && !isNaN(parseInt(lastArg))) {
                page = parseInt(lastArg);
                charTarget = remainder.slice(0, -1).join(' ');
            }

            const found = await showCharacterEventsByIdentifier(ctx, charTarget, page);
            if (!found) {
                await ctx.message.reply(t(ctx.locale, 'char.charNotFoundName', { name: charTarget }));
            }
            return;
        }

        // Subcommand: $character <name> events [page]
        const eventsMatch = arg.match(/^(.+?)\s+(events|eventi)(?:\s+(\d+))?$/i);
        if (eventsMatch) {
            const charName = eventsMatch[1].trim();
            const page = eventsMatch[3] ? parseInt(eventsMatch[3]) : 1;

            const found = await showCharacterEventsByIdentifier(ctx, charName, page);
            if (!found) {
                await ctx.message.reply(t(ctx.locale, 'char.charNotFoundName', { name: charName }));
            }
            return;
        }

        // Default view: List of characters
        const characters = characterRepository.getCampaignCharacters(ctx.activeCampaign!.id);

        if (characters.length === 0) {
            await ctx.message.reply(t(ctx.locale, 'char.noneRegistered'));
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle(t(ctx.locale, 'char.listTitle', { name: ctx.activeCampaign?.name ?? '' }))
            .setColor("#3498DB")
            .setDescription(
                characters.map(c => {
                    const classPart = c.class ? ` (${c.class})` : '';
                    return `• **${c.character_name}**${classPart}`;
                }).join('\n')
            )
            .setFooter({ text: t(ctx.locale, 'char.listFooter') });

        await ctx.message.reply({ embeds: [embed] });
    }
};

/**
 * Helper: Resolve character identifier and show events
 */
async function showCharacterEventsByIdentifier(ctx: CommandContext, identifier: string, page: number = 1): Promise<boolean> {
    const campaignId = ctx.activeCampaign!.id;

    // Character names are unique per campaign (mostly handled by getCharacterUserId)
    const userId = characterRepository.getCharacterUserId(campaignId, identifier.trim());
    if (!userId) return false;

    const profile = characterRepository.getUserProfile(userId, campaignId);
    if (!profile || !profile.character_name) return false;

    await showEntityEvents(ctx, {
        tableName: 'character_history',
        entityKeyColumn: 'character_name',
        entityKeyValue: profile.character_name,
        campaignId: campaignId,
        entityDisplayName: profile.character_name,
        entityEmoji: '👤'
    }, page);

    return true;
}

/**
 * Helper: Interactive selection for character events
 */
async function startCharacterEventsInteractiveSelection(ctx: CommandContext) {
    const campaignId = ctx.activeCampaign!.id;
    const characters = characterRepository.getCampaignCharacters(campaignId);

    if (characters.length === 0) {
        await ctx.message.reply(t(ctx.locale, 'char.noneRegistered'));
        return;
    }

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('select_character_events')
        .setPlaceholder(t(ctx.locale, 'char.selectForHistory'))
        .addOptions(
            characters.slice(0, 25).map(c => {
                return new StringSelectMenuOptionBuilder()
                    .setLabel(c.character_name || t(ctx.locale, 'char.unknown'))
                    .setDescription(`${c.race || t(ctx.locale, 'char.raceUnknown')} ${c.class || t(ctx.locale, 'char.classUnknown')}`)
                    .setValue(c.character_name || 'unknown')
                    .setEmoji('👤');
            })
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    const reply = await ctx.message.reply({
        content: t(ctx.locale, 'char.selectPromptHistory'),
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i) => i.customId === 'select_character_events' && i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction) => {
        const charName = interaction.values[0];
        // In this case, name is safe to use as identifier for lookup
        const found = await showCharacterEventsByIdentifier(ctx, charName, 1);

        if (found) {
            await interaction.update({ content: t(ctx.locale, 'crud.loadingEvents', { name: charName }), components: [] });
        } else {
            await interaction.reply({ content: t(ctx.locale, 'char.charNotFound'), ephemeral: true });
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            await reply.edit({ content: t(ctx.locale, 'crud.selectionTimeout'), components: [] }).catch(() => { });
        }
    });
}
