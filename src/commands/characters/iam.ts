/**
 * $sono / $iam command - Set character name and details interactively
 */

import { Command, CommandContext } from '../types';
import { updateUserCharacter, db, factionRepository, getUserProfile } from '../../db';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ComponentType,
    ButtonInteraction
} from 'discord.js';

export const iamCommand: Command = {
    name: 'iam',
    aliases: ['sono'],
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

        // If name is provided, update it immediately
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

        // Prepare interactivity
        const row = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_edit_profile')
                    .setLabel('📝 Completa Scheda')
                    .setStyle(ButtonStyle.Primary)
            );

        const replyContent = val
            ? `⚔️ Nome aggiornato: **${val}** (Campagna: ${ctx.activeCampaign!.name})\nVuoi aggiungere altri dettagli alla tua scheda?`
            : `👋 Ciao! Usa il pulsante qui sotto per creare o aggiornare il tuo personaggio.`;

        const reply = await ctx.message.reply({
            content: replyContent,
            components: [row]
        });

        const collector = reply.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
            filter: (i) => i.customId === 'btn_edit_profile' && i.user.id === userId
        });

        collector.on('collect', async (interaction: ButtonInteraction) => {
            // Fetch current data to pre-fill
            const profile = getUserProfile(userId, campaignId);
            const currentName = profile.character_name || val || "";
            const currentRace = profile.race || "";
            const currentClass = profile.class || "";
            const currentDesc = profile.description || "";
            const currentEmail = profile.email || "";

            const modal = new ModalBuilder()
                .setCustomId('modal_edit_profile')
                .setTitle('Scheda Personaggio');

            const nameInput = new TextInputBuilder()
                .setCustomId('char_name')
                .setLabel('Nome Personaggio')
                .setStyle(TextInputStyle.Short)
                .setValue(currentName)
                .setRequired(true);

            const raceInput = new TextInputBuilder()
                .setCustomId('char_race')
                .setLabel('Razza')
                .setStyle(TextInputStyle.Short)
                .setValue(currentRace)
                .setRequired(false);

            const classInput = new TextInputBuilder()
                .setCustomId('char_class')
                .setLabel('Classe')
                .setStyle(TextInputStyle.Short)
                .setValue(currentClass)
                .setRequired(false);

            const descInput = new TextInputBuilder()
                .setCustomId('char_desc')
                .setLabel('Descrizione Breve')
                .setStyle(TextInputStyle.Paragraph)
                .setValue(currentDesc)
                .setRequired(false);

            const emailInput = new TextInputBuilder()
                .setCustomId('char_email')
                .setLabel('Email per Recap (opzionale)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('email@esempio.com')
                .setValue(currentEmail)
                .setRequired(false);

            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
                new ActionRowBuilder<TextInputBuilder>().addComponents(raceInput),
                new ActionRowBuilder<TextInputBuilder>().addComponents(classInput),
                new ActionRowBuilder<TextInputBuilder>().addComponents(descInput),
                new ActionRowBuilder<TextInputBuilder>().addComponents(emailInput)
            );

            await interaction.showModal(modal);

            try {
                const submission = await interaction.awaitModalSubmit({
                    time: 300000,
                    filter: (i) => i.customId === 'modal_edit_profile' && i.user.id === userId
                });

                const newName = submission.fields.getTextInputValue('char_name');
                const newRace = submission.fields.getTextInputValue('char_race');
                const newClass = submission.fields.getTextInputValue('char_class');
                const newDesc = submission.fields.getTextInputValue('char_desc');
                const newEmail = submission.fields.getTextInputValue('char_email');

                updateUserCharacter(userId, campaignId, 'character_name', newName);
                if (newRace) updateUserCharacter(userId, campaignId, 'race', newRace);
                if (newClass) updateUserCharacter(userId, campaignId, 'class', newClass);
                if (newDesc) updateUserCharacter(userId, campaignId, 'description', newDesc);
                if (newEmail) updateUserCharacter(userId, campaignId, 'email', newEmail);

                const emailLine = newEmail ? `\n📧 Email: ${newEmail}` : '';
                await submission.reply({
                    content: `✅ **Scheda Aggiornata!**\n👤 **${newName}**\n🧬 Razza: ${newRace || "-"}\n⚔️ Classe: ${newClass || "-"}\n📜 ${newDesc || "-"}${emailLine}`,
                    ephemeral: false
                });

            } catch (err) {
                // Timeout or error
            }
        });

        collector.on('end', () => {
            try {
                const disabledRow = new ActionRowBuilder<ButtonBuilder>()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('btn_edit_profile')
                            .setLabel('📝 Completa Scheda')
                            .setStyle(ButtonStyle.Primary)
                            .setDisabled(true)
                    );
                reply.edit({ components: [disabledRow] }).catch(() => { });
            } catch { }
        });
    }
};
