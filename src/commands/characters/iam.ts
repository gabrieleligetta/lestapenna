/**
 * $sono / $iam / $profilo command - Unified character management
 */

import { Command, CommandContext } from '../types';
import {
    updateUserCharacter,
    db,
    factionRepository,
    getUserProfile,
    characterRepository
} from '../../db';
import { formatAlignmentSpectrum, getStoredAlignmentLabel } from '../../utils/alignmentUtils';
import { t, getCampaignLocale } from '../../i18n';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ComponentType,
    EmbedBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    InteractionResponse
} from 'discord.js';
import { ensureMembership } from '../../services/campaignAccess';

export const iamCommand: Command = {
    name: 'iam',
    category: 'personaggi',
    descriptionKey: 'help.cmd.iam',
    aliases: ['sono', 'profilo', 'profile'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const val = ctx.args.join(' ');
        const campaignId = ctx.activeCampaign!.id;
        const userId = ctx.message.author.id;

        // Special handling for DM
        if (val && (val.toUpperCase() === 'DM' || val.toUpperCase() === 'DUNGEON MASTER')) {
            // Creating a character is the gesture of sitting down at the table, and
            // the write permissions on web and bot follow from it.
            ensureMembership(campaignId, userId, 'MASTER');
            updateUserCharacter(userId, campaignId, 'character_name', 'DM');
            updateUserCharacter(userId, campaignId, 'class', 'Dungeon Master');
            updateUserCharacter(userId, campaignId, 'race', t(getCampaignLocale(campaignId), 'char.narratorRace'));
            await ctx.message.reply(t(ctx.locale, 'char.dmGreeting', { name: ctx.activeCampaign!.name }));
            return;
        }

        // If name is provided in args, update it immediately before showing the dashboard
        if (val) {
            ensureMembership(campaignId, userId);
            updateUserCharacter(userId, campaignId, 'character_name', val);

            // Auto-affiliate to party faction if exists
            const party = factionRepository.getPartyFaction(campaignId);
            if (party) {
                const charRow = db.prepare(`
                    SELECT rowid FROM characters WHERE user_id = ? AND campaign_id = ?
                `).get(userId, campaignId) as { rowid: number } | undefined;

                if (charRow) {
                    factionRepository.addAffiliation(party.id, 'pc', charRow.rowid, { role: 'MEMBER' });
                }
            }
        }

        await showProfileDashboard(ctx);
    }
};

async function showProfileDashboard(ctx: CommandContext, interactionToUpdate?: any) {
    const userId = ctx.message.author.id;
    const campaignId = ctx.activeCampaign!.id;
    const profile = getUserProfile(userId, campaignId);

    const embed = new EmbedBuilder()
        .setTitle(t(ctx.locale, 'char.sheetTitle', { name: profile.character_name || t(ctx.locale, 'char.newHero') }))
        .setColor(0x00AE86)
        .setDescription(t(ctx.locale, 'char.sheetDesc', { name: ctx.activeCampaign!.name }))
        .addFields(
            { name: t(ctx.locale, 'char.fieldRace'), value: profile.race || t(ctx.locale, 'char.notSet'), inline: true },
            { name: t(ctx.locale, 'char.fieldClass'), value: profile.class || t(ctx.locale, 'char.notSet'), inline: true },
            { name: t(ctx.locale, 'char.fieldEmail'), value: profile.email || t(ctx.locale, 'char.notSet'), inline: true },
            { name: t(ctx.locale, 'char.alignChosen'), value: (profile.alignment_ethical && profile.alignment_moral) ? getStoredAlignmentLabel(ctx.locale, profile.alignment_moral, profile.alignment_ethical) : t(ctx.locale, 'char.notSet'), inline: false },
            { name: t(ctx.locale, 'char.alignReal'), value: formatAlignmentSpectrum(ctx.locale, profile.moral_score ?? 0, profile.ethical_score ?? 0), inline: false },
            { name: t(ctx.locale, 'char.fieldBackground'), value: profile.foundation_description || profile.description || t(ctx.locale, 'char.noBackground'), inline: false }
        );

    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('cp_edit_base').setLabel(t(ctx.locale, 'char.btnBaseDetails')).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('cp_edit_bg').setLabel(t(ctx.locale, 'char.btnBackground')).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('cp_edit_align').setLabel(t(ctx.locale, 'char.btnAlignment')).setStyle(ButtonStyle.Primary)
    );

    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('cp_edit_email').setLabel(t(ctx.locale, 'char.btnEmail')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cp_reset').setLabel(t(ctx.locale, 'char.btnReset')).setStyle(ButtonStyle.Danger)
    );

    const options = { embeds: [embed], components: [row1, row2] };
    let reply: InteractionResponse | any;

    if (interactionToUpdate) {
        reply = await interactionToUpdate.update(options);
    } else {
        reply = await ctx.message.reply(options);
    }

    const collector = (interactionToUpdate ? interactionToUpdate.message : reply).createMessageComponentCollector({
        time: 300000, // 5 minutes
        filter: (i: any) => i.user.id === userId
    });

    collector.on('collect', async (interaction: any) => {
        if (interaction.customId === 'cp_edit_base') {
            const modal = new ModalBuilder().setCustomId('modal_cp_base').setTitle(t(ctx.locale, 'char.modalBaseTitle'));
            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder().setCustomId('name').setLabel(t(ctx.locale, 'char.labelName')).setStyle(TextInputStyle.Short).setValue(profile.character_name || '').setRequired(true)
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder().setCustomId('race').setLabel(t(ctx.locale, 'char.labelRace')).setStyle(TextInputStyle.Short).setValue(profile.race || '').setRequired(false)
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder().setCustomId('class').setLabel(t(ctx.locale, 'char.labelClass')).setStyle(TextInputStyle.Short).setValue(profile.class || '').setRequired(false)
                )
            );
            await interaction.showModal(modal);
            try {
                const submission = await interaction.awaitModalSubmit({ time: 300000, filter: (i: any) => i.user.id === userId });
                updateUserCharacter(userId, campaignId, 'character_name', submission.fields.getTextInputValue('name'));
                updateUserCharacter(userId, campaignId, 'race', submission.fields.getTextInputValue('race'));
                updateUserCharacter(userId, campaignId, 'class', submission.fields.getTextInputValue('class'));
                collector.stop();
                await showProfileDashboard(ctx, submission);
            } catch (e) { }

        } else if (interaction.customId === 'cp_edit_bg') {
            const modal = new ModalBuilder().setCustomId('modal_cp_bg').setTitle(t(ctx.locale, 'char.modalBgTitle'));
            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('bg')
                        .setLabel(t(ctx.locale, 'char.labelBgDescribe'))
                        .setStyle(TextInputStyle.Paragraph)
                        .setValue(profile.foundation_description || profile.description || '')
                        .setRequired(true)
                )
            );
            await interaction.showModal(modal);
            try {
                const submission = await interaction.awaitModalSubmit({ time: 300000, filter: (i: any) => i.user.id === userId });
                characterRepository.updateFoundationDescription(userId, campaignId, submission.fields.getTextInputValue('bg'));
                collector.stop();
                await showProfileDashboard(ctx, submission);
            } catch (e) { }

        } else if (interaction.customId === 'cp_edit_align') {
            const select = new StringSelectMenuBuilder()
                .setCustomId('cp_select_align')
                .setPlaceholder(t(ctx.locale, 'char.alignSelectPlaceholder'))
                .addOptions(
                    new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'align.LAWFUL_GOOD')).setValue('LAWFUL_GOOD').setEmoji('😇'),
                    new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'align.NEUTRAL_GOOD')).setValue('NEUTRAL_GOOD').setEmoji('☀️'),
                    new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'align.CHAOTIC_GOOD')).setValue('CHAOTIC_GOOD').setEmoji('🌈'),
                    new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'align.LAWFUL_NEUTRAL')).setValue('LAWFUL_NEUTRAL').setEmoji('📜'),
                    new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'align.NEUTRAL_NEUTRAL')).setValue('NEUTRAL_NEUTRAL').setEmoji('⚖️'),
                    new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'align.CHAOTIC_NEUTRAL')).setValue('CHAOTIC_NEUTRAL').setEmoji('🌀'),
                    new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'align.LAWFUL_EVIL')).setValue('LAWFUL_EVIL').setEmoji('😈'),
                    new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'align.NEUTRAL_EVIL')).setValue('NEUTRAL_EVIL').setEmoji('🌑'),
                    new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'align.CHAOTIC_EVIL')).setValue('CHAOTIC_EVIL').setEmoji('💀')
                );

            const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
            await interaction.update({ content: t(ctx.locale, 'char.alignPrompt'), components: [row] });

            try {
                const selection = await (interactionToUpdate ? interactionToUpdate.message : reply).awaitMessageComponent({
                    componentType: ComponentType.StringSelect,
                    filter: (i: any) => i.user.id === userId,
                    time: 60000
                });
                const [ethical, moral] = selection.values[0].split('_');
                characterRepository.updateCharacterAlignment(campaignId, profile.character_name!, moral, ethical);
                collector.stop();
                await showProfileDashboard(ctx, selection);
            } catch (e) {
                collector.stop();
                await showProfileDashboard(ctx);
            }

        } else if (interaction.customId === 'cp_edit_email') {
            const modal = new ModalBuilder().setCustomId('modal_cp_email').setTitle(t(ctx.locale, 'char.modalEmailTitle'));
            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('email')
                        .setLabel(t(ctx.locale, 'char.labelEmailSend'))
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('utente@example.com')
                        .setValue(profile.email || '')
                        .setRequired(false)
                )
            );
            await interaction.showModal(modal);
            try {
                const submission = await interaction.awaitModalSubmit({ time: 300000, filter: (i: any) => i.user.id === userId });
                updateUserCharacter(userId, campaignId, 'email', submission.fields.getTextInputValue('email'));
                collector.stop();
                await showProfileDashboard(ctx, submission);
            } catch (e) { }

        } else if (interaction.customId === 'cp_reset') {
            const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('cp_confirm_reset').setLabel(t(ctx.locale, 'char.btnConfirmReset')).setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('cp_cancel_reset').setLabel(t(ctx.locale, 'common.cancel')).setStyle(ButtonStyle.Secondary)
            );
            await interaction.update({ content: t(ctx.locale, 'char.resetConfirmPrompt'), embeds: [], components: [confirmRow] });

            try {
                const confirmation = await (interactionToUpdate ? interactionToUpdate.message : reply).awaitMessageComponent({
                    componentType: ComponentType.Button,
                    filter: (i: any) => i.user.id === userId,
                    time: 30000
                });
                if (confirmation.customId === 'cp_confirm_reset') {
                    db.prepare('DELETE FROM characters WHERE user_id = ? AND campaign_id = ?').run(userId, campaignId);
                    await confirmation.update({ content: t(ctx.locale, 'char.profileDeleted'), components: [], embeds: [] });
                } else {
                    collector.stop();
                    await showProfileDashboard(ctx, confirmation);
                }
            } catch (e) {
                collector.stop();
                await showProfileDashboard(ctx);
            }
        }
    });

    collector.on('end', (collected: any, reason: string) => {
        if (reason === 'time') {
            // Optional: disable buttons on timeout
        }
    });
}
