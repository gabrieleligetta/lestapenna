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
import { parseSummaryData } from '../../bard/summaryData';
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
import { t } from '../../i18n';

export const cronacaCommand: Command = {
    name: 'session',
    category: 'sessione',
    descriptionKey: 'help.cmd.session',
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
            .setTitle(t(ctx.locale, 'session.dashActiveTitle'))
            .setColor(0xEEAA00)
            .setDescription(t(ctx.locale, 'session.dashActiveDesc', { id: activeSessionId, campaign: activeCampaign?.name || 'N/A' }))
            .addFields(
                { name: t(ctx.locale, 'session.fieldSessionId'), value: `\`${activeSessionId}\``, inline: true },
                { name: t(ctx.locale, 'session.fieldPlace'), value: t(ctx.locale, 'session.trackingActive'), inline: true }
            );

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('sd_add_note').setLabel(t(ctx.locale, 'session.btnNote')).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('sd_set_num').setLabel(t(ctx.locale, 'session.btnNumber')).setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('sd_stop').setLabel(t(ctx.locale, 'session.btnStop')).setStyle(ButtonStyle.Danger)
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
                const modal = new ModalBuilder().setCustomId('modal_sd_note').setTitle(t(ctx.locale, 'session.noteModalTitle'));
                modal.addComponents(
                    new ActionRowBuilder<TextInputBuilder>().addComponents(
                        new TextInputBuilder().setCustomId('note').setLabel(t(ctx.locale, 'session.noteModalLabel')).setStyle(TextInputStyle.Paragraph).setRequired(true)
                    )
                );
                await interaction.showModal(modal);
                try {
                    const submission = await interaction.awaitModalSubmit({ time: 300000, filter: (i: any) => i.user.id === userId });
                    addSessionNote(activeSessionId, userId, submission.fields.getTextInputValue('note'), Date.now());
                    await submission.reply({ content: t(ctx.locale, 'session.noteAdded'), ephemeral: true });
                } catch (e) { }

            } else if (interaction.customId === 'sd_set_num') {
                const modal = new ModalBuilder().setCustomId('modal_sd_num').setTitle(t(ctx.locale, 'session.numModalTitle'));
                modal.addComponents(
                    new ActionRowBuilder<TextInputBuilder>().addComponents(
                        new TextInputBuilder().setCustomId('num').setLabel(t(ctx.locale, 'session.numModalLabel')).setStyle(TextInputStyle.Short).setPlaceholder(t(ctx.locale, 'session.numModalPlaceholder')).setRequired(true)
                    )
                );
                await interaction.showModal(modal);
                try {
                    const submission = await interaction.awaitModalSubmit({ time: 300000, filter: (i: any) => i.user.id === userId });
                    const num = parseInt(submission.fields.getTextInputValue('num'));
                    if (!isNaN(num)) {
                        setSessionNumber(activeSessionId, num);
                        await submission.reply({ content: t(ctx.locale, 'session.numSet', { n: num }), ephemeral: true });
                    } else {
                        await submission.reply({ content: t(ctx.locale, 'session.numInvalid'), ephemeral: true });
                    }
                } catch (e) { }

            } else if (interaction.customId === 'sd_stop') {
                const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId('sd_confirm_stop').setLabel(t(ctx.locale, 'session.confirmStopYes')).setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId('sd_cancel_stop').setLabel(t(ctx.locale, 'common.cancel')).setStyle(ButtonStyle.Secondary)
                );
                await interaction.update({ content: t(ctx.locale, 'session.confirmStop'), embeds: [], components: [confirmRow] });

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
            .setTitle(t(ctx.locale, 'session.dashArchiveTitle'))
            .setColor(0x7289DA)
            .setDescription(activeCampaign
                ? t(ctx.locale, 'session.dashArchiveDesc', { campaign: activeCampaign.name })
                : t(ctx.locale, 'session.dashArchiveDescNoCamp'))
            .setFooter({
                text: lastSession
                    ? t(ctx.locale, 'session.lastSessionFooter', { date: new Date(lastSession.start_time).toLocaleDateString() })
                    : t(ctx.locale, 'session.noSessionsFooter')
            });

        if (lastSession) {
            const aiData = getSessionAIOutput(lastSession.session_id);
            const summaryData = parseSummaryData(aiData?.summaryData);
            const brief = summaryData?.brief || '';
            embed.addFields({
                name: t(ctx.locale, 'session.lastSessionField', { id: lastSession.session_id }),
                value: brief ? `${brief.substring(0, 300)}...` : t(ctx.locale, 'session.noSummary')
            });
        }

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('sd_start').setLabel(t(ctx.locale, 'session.btnStart')).setStyle(ButtonStyle.Success).setDisabled(!activeCampaign),
            new ButtonBuilder().setCustomId('sd_history').setLabel(t(ctx.locale, 'session.btnHistory')).setStyle(ButtonStyle.Secondary)
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
