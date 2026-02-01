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

export const iamCommand: Command = {
    name: 'iam',
    aliases: ['sono', 'profilo', 'profile', 'pg', 'character', 'personaggio'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const val = ctx.args.join(' ');
        const campaignId = ctx.activeCampaign!.id;
        const userId = ctx.message.author.id;

        // Special handling for DM
        if (val && (val.toUpperCase() === 'DM' || val.toUpperCase() === 'DUNGEON MASTER')) {
            updateUserCharacter(userId, campaignId, 'character_name', 'DM');
            updateUserCharacter(userId, campaignId, 'class', 'Dungeon Master');
            updateUserCharacter(userId, campaignId, 'race', 'Narratore');
            await ctx.message.reply(`🎲 **Saluti, Dungeon Master.** Il Bardo è ai tuoi ordini per la campagna **${ctx.activeCampaign!.name}**.`);
            return;
        }

        // If name is provided in args, update it immediately before showing the dashboard
        if (val) {
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
        .setTitle(`👤 Scheda Personaggio: ${profile.character_name || 'Nuovo Eroe'}`)
        .setColor(0x00AE86)
        .setDescription(`Gestisci i dettagli del tuo personaggio per la campagna **${ctx.activeCampaign!.name}**.`)
        .addFields(
            { name: '🧬 Razza', value: profile.race || '_Non impostata_', inline: true },
            { name: '⚔️ Classe', value: profile.class || '_Non impostata_', inline: true },
            { name: '⚖️ Allineamento', value: `${profile.alignment_ethical || 'NEUTRALE'} ${profile.alignment_moral || 'NEUTRALE'}`, inline: true },
            { name: '📜 Background (Manuale)', value: profile.foundation_description || profile.description || '_Nessun background inserito manualment._', inline: false },
            { name: '📧 Email Recap', value: profile.email || '_Non impostata_', inline: true }
        );

    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('cp_edit_base').setLabel('🏷️ Dettagli Base').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('cp_edit_bg').setLabel('📜 Background').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('cp_edit_align').setLabel('⚖️ Allineamento').setStyle(ButtonStyle.Primary)
    );

    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('cp_edit_email').setLabel('📧 Email').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cp_reset').setLabel('🗑️ Reset').setStyle(ButtonStyle.Danger)
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
            const modal = new ModalBuilder().setCustomId('modal_cp_base').setTitle('Dettagli Base');
            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder().setCustomId('name').setLabel('Nome').setStyle(TextInputStyle.Short).setValue(profile.character_name || '').setRequired(true)
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder().setCustomId('race').setLabel('Razza').setStyle(TextInputStyle.Short).setValue(profile.race || '').setRequired(false)
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder().setCustomId('class').setLabel('Classe').setStyle(TextInputStyle.Short).setValue(profile.class || '').setRequired(false)
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
            const modal = new ModalBuilder().setCustomId('modal_cp_bg').setTitle('Background Personaggio');
            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('bg')
                        .setLabel('Descrivi le tue origini e motivazioni')
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
                .setPlaceholder('Scegli il tuo allineamento...')
                .addOptions(
                    new StringSelectMenuOptionBuilder().setLabel('Legale Buono').setValue('LEGALE_BUONO').setEmoji('😇'),
                    new StringSelectMenuOptionBuilder().setLabel('Neutrale Buono').setValue('NEUTRALE_BUONO').setEmoji('☀️'),
                    new StringSelectMenuOptionBuilder().setLabel('Caotico Buono').setValue('CAOTICO_BUONO').setEmoji('🌈'),
                    new StringSelectMenuOptionBuilder().setLabel('Legale Neutrale').setValue('LEGALE_NEUTRALE').setEmoji('📜'),
                    new StringSelectMenuOptionBuilder().setLabel('Neutrale Puro').setValue('NEUTRALE_NEUTRALE').setEmoji('⚖️'),
                    new StringSelectMenuOptionBuilder().setLabel('Caotico Neutrale').setValue('CAOTICO_NEUTRALE').setEmoji('🌀'),
                    new StringSelectMenuOptionBuilder().setLabel('Legale Malvagio').setValue('LEGALE_CATTIVO').setEmoji('😈'),
                    new StringSelectMenuOptionBuilder().setLabel('Neutrale Malvagio').setValue('NEUTRALE_CATTIVO').setEmoji('🌑'),
                    new StringSelectMenuOptionBuilder().setLabel('Caotico Malvagio').setValue('CAOTICO_CATTIVO').setEmoji('💀')
                );

            const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
            await interaction.update({ content: 'Scegli il tuo allineamento morale ed etico:', components: [row] });

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
            const modal = new ModalBuilder().setCustomId('modal_cp_email').setTitle('Email per Recap');
            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('email')
                        .setLabel('Invia i riassunti a questo indirizzo')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('esempio@gmail.com')
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
                new ButtonBuilder().setCustomId('cp_confirm_reset').setLabel('Sì, cancella tutto').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('cp_cancel_reset').setLabel('Annulla').setStyle(ButtonStyle.Secondary)
            );
            await interaction.update({ content: '⚠️ **Sei sicuro?** Questa operazione cancellerà irrevocabilmente il tuo profilo in questa campagna.', embeds: [], components: [confirmRow] });

            try {
                const confirmation = await (interactionToUpdate ? interactionToUpdate.message : reply).awaitMessageComponent({
                    componentType: ComponentType.Button,
                    filter: (i: any) => i.user.id === userId,
                    time: 30000
                });
                if (confirmation.customId === 'cp_confirm_reset') {
                    db.prepare('DELETE FROM characters WHERE user_id = ? AND campaign_id = ?').run(userId, campaignId);
                    await confirmation.update({ content: '✅ Profilo cancellato con successo.', components: [], embeds: [] });
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
