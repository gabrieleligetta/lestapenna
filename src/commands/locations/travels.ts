/**
 * $viaggi / $travels command - Travel history management
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction } from 'discord.js';
import { Command, CommandContext } from '../types';
import {
    getLocationHistory,
    getLocationHistoryWithIds,
    getSessionTravelLog,
    fixLocationHistoryEntry,
    deleteLocationHistoryEntry,
    fixCurrentLocation,
    db
} from '../../db';
import { isSessionId, extractSessionId } from '../../utils/sessionId';
import { t, dateLocale } from '../../i18n';
import { assertCampaignWrite } from '../utils/campaignWrite';
import { assertSessionInActiveCampaign } from '../utils/sessionScope';

export const travelsCommand: Command = {
    name: 'travels',
    category: 'mondo',
    descriptionKey: 'help.cmd.travels',
    aliases: ['viaggi'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const argsStr = ctx.args.join(' ');

        // --- SESSION SPECIFIC: $viaggi <session_id> ---
        if (argsStr && isSessionId(argsStr)) {
            const sessionId = extractSessionId(argsStr);
            if (!await assertSessionInActiveCampaign(ctx, sessionId)) return;
            const travelLog = getSessionTravelLog(sessionId);

            if (travelLog.length === 0) {
                await ctx.message.reply(t(ctx.locale, 'travel.sessionNone', { id: sessionId }));
                return;
            }

            let msg = t(ctx.locale, 'travel.sessionHeader', { id: sessionId }) + '\n';
            travelLog.forEach((h: any) => {
                const time = new Date(h.timestamp).toLocaleTimeString(dateLocale(ctx.locale), { hour: '2-digit', minute: '2-digit' });
                const sessionNum = h.session_number ? `**[S${h.session_number}]** ` : '';
                msg += `\`${time}\` ${sessionNum}🌍 **${h.macro_location || '-'}** 👉 🏠 ${h.micro_location || t(ctx.locale, 'travel.outside')}\n`;
            });

            await ctx.message.reply(msg);
            return;
        }

        // --- SUBCOMMAND: fix (correct entry) ---
        if (argsStr.toLowerCase().startsWith('fix ') && !argsStr.toLowerCase().startsWith('fixcurrent')) {
            if (!await assertCampaignWrite(ctx)) return;
            const fixArgs = argsStr.substring(4).trim();
            const parts = fixArgs.split('|').map(s => s.trim());

            if (parts.length !== 3) {
                await ctx.message.reply(t(ctx.locale, 'travel.fixUsage'));
                return;
            }

            const shortId = parts[0].replace('#', '').trim();
            const [, newMacro, newMicro] = parts;

            const entry = db.prepare(
                'SELECT id FROM location_history WHERE short_id = ? AND campaign_id = ?',
            ).get(shortId, ctx.activeCampaign!.id) as any;
            if (entry) {
                const success = fixLocationHistoryEntry(entry.id, newMacro, newMicro);
                if (success) {
                    await ctx.message.reply(t(ctx.locale, 'travel.fixed', { id: shortId, macro: newMacro, micro: newMicro }));
                } else {
                    await ctx.message.reply(t(ctx.locale, 'travel.fixError', { id: shortId }));
                }
            } else {
                await ctx.message.reply(t(ctx.locale, 'travel.entryNotFound', { id: shortId }));
            }
            return;
        }

        // --- SUBCOMMAND: delete (delete entry) ---
        if (argsStr.toLowerCase().startsWith('delete ') || argsStr.toLowerCase().startsWith('del ') || argsStr.toLowerCase().startsWith('remove ')) {
            if (!await assertCampaignWrite(ctx)) return;
            const shortId = argsStr.split(' ')[1].replace('#', '').trim();

            const entry = db.prepare(
                'SELECT id FROM location_history WHERE short_id = ? AND campaign_id = ?',
            ).get(shortId, ctx.activeCampaign!.id) as any;
            if (entry) {
                const success = deleteLocationHistoryEntry(entry.id);
                if (success) {
                    await ctx.message.reply(t(ctx.locale, 'travel.deleted', { id: shortId }));
                } else {
                    await ctx.message.reply(t(ctx.locale, 'travel.deleteError', { id: shortId }));
                }
            } else {
                await ctx.message.reply(t(ctx.locale, 'travel.entryNotFound', { id: shortId }));
            }
            return;
        }

        // --- SUBCOMMAND: fixcurrent (fix current position) ---
        if (argsStr.toLowerCase().startsWith('fixcurrent ') || argsStr.toLowerCase().startsWith('correggi ')) {
            if (!await assertCampaignWrite(ctx)) return;
            const fixArgs = argsStr.substring(argsStr.indexOf(' ') + 1).trim();
            const parts = fixArgs.split('|').map(s => s.trim());

            if (parts.length !== 2) {
                await ctx.message.reply(t(ctx.locale, 'travel.fixcurrentUsage'));
                return;
            }

            const [newMacro, newMicro] = parts;
            fixCurrentLocation(ctx.activeCampaign!.id, newMacro, newMicro);
            await ctx.message.reply(t(ctx.locale, 'travel.currentFixed', { macro: newMacro, micro: newMicro }));
            return;
        }

        // --- LIST / PAGINATION ---
        // Default view or explicit list command
        // $viaggi list [page]
        let initialPage = 1;
        if (argsStr.toLowerCase().startsWith('list') || argsStr.toLowerCase().startsWith('lista')) {
            const parts = argsStr.split(' ');
            if (parts.length > 1 && !isNaN(parseInt(parts[1]))) {
                initialPage = parseInt(parts[1]);
            }
        }

        const ITEMS_PER_PAGE = 10;
        let currentPage = Math.max(0, initialPage - 1);

        // We need a paginated fetcher for history. 
        // Existing `getLocationHistoryWithIds` fetches ALL.
        // We can slice it in memory for now since history isn't massive yet, 
        // or we should add pagination to DB. For consistency with other commands, let's slice.
        const fullHistory = getLocationHistoryWithIds(ctx.activeCampaign!.id);

        const generateEmbed = (page: number) => {
            const offset = page * ITEMS_PER_PAGE;
            const items = fullHistory.slice(offset, offset + ITEMS_PER_PAGE);
            const total = fullHistory.length;
            const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

            if (items.length === 0 && total > 0 && page > 0) {
                return { embed: new EmbedBuilder().setDescription(t(ctx.locale, 'common.pageNotExist')), totalPages: Math.ceil(total / ITEMS_PER_PAGE) };
            }

            if (total === 0) {
                return { embed: new EmbedBuilder().setDescription(t(ctx.locale, 'travel.emptyDiary')), totalPages: 0 };
            }

            const list = items.map((h: any) => {
                const time = new Date(h.timestamp).toLocaleTimeString(dateLocale(ctx.locale), { hour: '2-digit', minute: '2-digit' });
                const sessionNum = h.session_number ? `**[S${h.session_number}]** ` : '';
                return `\`#${h.short_id}\` \`${h.session_date} ${time}\` ${sessionNum}🌍 **${h.macro_location || '-'}** 👉 🏠 ${h.micro_location || t(ctx.locale, 'travel.outside')}`;
            }).join('\n');

            const embed = new EmbedBuilder()
                .setTitle(t(ctx.locale, 'travel.listTitle', { campaign: ctx.activeCampaign?.name || '' }))
                .setColor("#95A5A6")
                .setDescription(list)
                .setFooter({ text: t(ctx.locale, 'common.pageFooterTotal', { page: page + 1, total: totalPages, n: total }) });

            return { embed, totalPages };
        };

        const generateButtons = (page: number, totalPages: number) => {
            const row = new ActionRowBuilder<ButtonBuilder>();
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId('prev_page')
                    .setLabel(t(ctx.locale, 'common.prevButton'))
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('next_page')
                    .setLabel(t(ctx.locale, 'common.nextButton'))
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages - 1)
            );
            return row;
        };

        const initialData = generateEmbed(currentPage);

        if (initialData.totalPages === 0 || !initialData.embed.data.title) {
            await ctx.message.reply({ embeds: [initialData.embed] });
            return;
        }

        const reply = await ctx.message.reply({
            embeds: [initialData.embed],
            components: initialData.totalPages > 1 ? [generateButtons(currentPage, initialData.totalPages)] : []
        });

        if (initialData.totalPages > 1) {
            const collector = reply.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 60000 * 5 // 5 minutes
            });

            collector.on('collect', async (interaction: MessageComponentInteraction) => {
                if (interaction.user.id !== ctx.message.author.id) {
                    await interaction.reply({ content: t(ctx.locale, 'common.onlyInvoker'), ephemeral: true });
                    return;
                }

                if (interaction.customId === 'prev_page') {
                    currentPage = Math.max(0, currentPage - 1);
                } else if (interaction.customId === 'next_page') {
                    currentPage++;
                }

                const newData = generateEmbed(currentPage);
                await interaction.update({
                    embeds: [newData.embed],
                    components: [generateButtons(currentPage, newData.totalPages)]
                });
            });

            collector.on('end', () => {
                reply.edit({ components: [] }).catch(() => { });
            });
        }
    }
};
