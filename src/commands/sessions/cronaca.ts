/**
 * $session / $cronaca command - Unified session management dashboard
 */

import { Command, CommandContext } from '../types';
import {
    getAvailableSessions,
    getSessionAIOutput,
    addSessionNote,
    setSessionNumber,
    db
} from '../../db';
import { getActiveSession } from '../../state/sessionState';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ComponentType,
    InteractionResponse
} from 'discord.js';
import { stopCommand } from './stop';
import { listenCommand } from './listen';

export const cronacaCommand: Command = {
    name: 'session',
    aliases: ['sessione', 'cronaca', 'manage_session'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        await showSessionDashboard(ctx);
    }
};

async function showSessionDashboard(ctx: CommandContext, interactionToUpdate?: any) {
    const { message, activeCampaign, guildId } = ctx;
    const userId = message.author.id;
    const activeSessionId = await getActiveSession(guildId!);

    if (activeSessionId) {
        // ACTIVE SESSION VIEW
        const embed = new EmbedBuilder()
            .setTitle(`🎙️ Sessione in Corso`)
            .setColor(0xEEAA00)
            .setDescription(`Il Bardo sta ascoltando la sessione \`${activeSessionId}\` per la campagna **${activeCampaign?.name || 'N/A'}**.`)
            .addFields(
                { name: '🆔 ID Sessione', value: `\`${activeSessionId}\``, inline: true },
                { name: '📍 Luogo', value: 'Tracciamento attivo', inline: true }
            );

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('sd_add_note').setLabel('📝 Nota').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('sd_set_num').setLabel('🔢 Numero').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('sd_stop').setLabel('🛑 Termina').setStyle(ButtonStyle.Danger)
        );

        const options = { embeds: [embed], components: [row] };
        let reply: InteractionResponse | any;

        if (interactionToUpdate) {
            reply = await interactionToUpdate.update(options);
        } else {
            reply = await ctx.message.reply(options);
        }

        const collector = (interactionToUpdate ? interactionToUpdate.message : reply).createMessageComponentCollector({
            time: 300000,
            filter: (i: any) => i.user.id === userId
        });

        collector.on('collect', async (interaction: any) => {
            if (interaction.customId === 'sd_add_note') {
                const modal = new ModalBuilder().setCustomId('modal_sd_note').setTitle('Aggiungi Nota');
                modal.addComponents(
                    new ActionRowBuilder<TextInputBuilder>().addComponents(
                        new TextInputBuilder().setCustomId('note').setLabel('Testo della nota').setStyle(TextInputStyle.Paragraph).setRequired(true)
                    )
                );
                await interaction.showModal(modal);
                try {
                    const submission = await interaction.awaitModalSubmit({ time: 300000, filter: (i: any) => i.user.id === userId });
                    addSessionNote(activeSessionId, userId, submission.fields.getTextInputValue('note'), Date.now());
                    await submission.reply({ content: '✅ Nota aggiunta!', ephemeral: true });
                } catch (e) { }

            } else if (interaction.customId === 'sd_set_num') {
                const modal = new ModalBuilder().setCustomId('modal_sd_num').setTitle('Numero Sessione');
                modal.addComponents(
                    new ActionRowBuilder<TextInputBuilder>().addComponents(
                        new TextInputBuilder().setCustomId('num').setLabel('Numero della sessione').setStyle(TextInputStyle.Short).setPlaceholder('es: 5').setRequired(true)
                    )
                );
                await interaction.showModal(modal);
                try {
                    const submission = await interaction.awaitModalSubmit({ time: 300000, filter: (i: any) => i.user.id === userId });
                    const num = parseInt(submission.fields.getTextInputValue('num'));
                    if (!isNaN(num)) {
                        setSessionNumber(activeSessionId, num);
                        await submission.reply({ content: `✅ Numero sessione impostato a **${num}**.`, ephemeral: true });
                    } else {
                        await submission.reply({ content: '❌ Numero non valido.', ephemeral: true });
                    }
                } catch (e) { }

            } else if (interaction.customId === 'sd_stop') {
                const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId('sd_confirm_stop').setLabel('Sì, termina ora').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId('sd_cancel_stop').setLabel('Annulla').setStyle(ButtonStyle.Secondary)
                );
                await interaction.update({ content: '⚠️ **Sei sicuro di voler terminare la registrazione?**', embeds: [], components: [confirmRow] });

                try {
                    const confirmation = await (interactionToUpdate ? interactionToUpdate.message : reply).awaitMessageComponent({
                        componentType: ComponentType.Button,
                        filter: (i: any) => i.user.id === userId,
                        time: 30000
                    });
                    if (confirmation.customId === 'sd_confirm_stop') {
                        collector.stop();
                        await stopCommand.execute({ ...ctx, interaction: confirmation }); // Use existing stop logic
                    } else {
                        collector.stop();
                        await showSessionDashboard(ctx, confirmation);
                    }
                } catch (e) {
                    collector.stop();
                    await showSessionDashboard(ctx);
                }
            }
        });

    } else {
        // INACTIVE SESSION VIEW
        const sessions = getAvailableSessions(guildId!, activeCampaign?.id, 0);
        const lastSession = sessions[0];

        const embed = new EmbedBuilder()
            .setTitle(`📜 Archivio Cronache`)
            .setColor(0x7289DA)
            .setDescription(activeCampaign ? `Gestione sessioni per la campagna **${activeCampaign.name}**.` : "Seleziona una campagna per vedere i dettagli delle sessioni.")
            .setFooter({ text: lastSession ? `Ultima sessione: ${new Date(lastSession.start_time).toLocaleDateString()}` : "Nessuna sessione trovata" });

        if (lastSession) {
            const aiData = getSessionAIOutput(lastSession.session_id);
            const narrativeBrief = aiData?.summaryData?.narrativeBrief;
            embed.addFields({
                name: `Ultima Sessione (ID: ${lastSession.session_id})`,
                value: narrativeBrief ? `${narrativeBrief.substring(0, 300)}...` : "*Nessun riassunto disponibile.*"
            });
        }

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('sd_start').setLabel('▶️ Inizia Cronaca').setStyle(ButtonStyle.Success).setDisabled(!activeCampaign),
            new ButtonBuilder().setCustomId('sd_history').setLabel('📜 Cronologia').setStyle(ButtonStyle.Secondary)
        );

        const options = { embeds: [embed], components: [row] };
        let reply: InteractionResponse | any;

        if (interactionToUpdate) {
            reply = await interactionToUpdate.update(options);
        } else {
            reply = await ctx.message.reply(options);
        }

        const collector = (interactionToUpdate ? interactionToUpdate.message : reply).createMessageComponentCollector({
            time: 300000,
            filter: (i: any) => i.user.id === userId
        });

        collector.on('collect', async (interaction: any) => {
            if (interaction.customId === 'sd_start') {
                collector.stop();
                await listenCommand.execute({ ...ctx, interaction });
            } else if (interaction.customId === 'sd_history') {
                collector.stop();
                const { listCommand } = await import('./list');
                await listCommand.execute({ ...ctx, interaction });
            }
        });
    }
}
