/**
 * $timeline / $cronologia command - World timeline management
 */

import { TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { addWorldEvent, deleteWorldEvent, getWorldTimeline, db, getWorldEventByShortId } from '../../db';
import { safeSend } from '../../utils/discordHelper';
import { startInteractiveTimelineAdd, startInteractiveTimelineUpdate, startInteractiveTimelineDelete } from './interactiveUpdate';
import { t, yearLabel } from '../../i18n';
import { deleteEntityFromCommand, deleteSummaryLine } from '../utils/entityDelete';

export const timelineCommand: Command = {
    name: 'timeline',
    category: 'mondo',
    descriptionKey: 'help.cmd.timeline',
    aliases: ['cronologia'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const arg = ctx.args.join(' ');

        // Subcommand: $timeline add <Year> | <Type> | <Description>
        if (arg.toLowerCase() === 'add' || arg.toLowerCase().startsWith('add ')) {
            const content = arg.substring(4).trim();
            if (!content) {
                await startInteractiveTimelineAdd(ctx);
                return;
            }

            const parts = content.split('|').map(s => s.trim());
            if (parts.length < 3) {
                await ctx.message.reply(t(ctx.locale, 'timeline.addUsage'));
                return;
            }

            const year = parseInt(parts[0]);
            const type = parts[1].toUpperCase();
            const desc = parts[2];

            if (isNaN(year)) {
                await ctx.message.reply(t(ctx.locale, 'timeline.yearMustBeNumber'));
                return;
            }

            addWorldEvent(ctx.activeCampaign!.id, null, desc, type, year, true);
            await ctx.message.reply(t(ctx.locale, 'timeline.eventAdded', { year }));
            return;
        }

        // Subcommand: $timeline update [#ID]
        if (arg.toLowerCase() === 'update' || arg.toLowerCase().startsWith('update ')) {
            await startInteractiveTimelineUpdate(ctx);
            return;
        }

        // Subcommand: $timeline delete <#ID>
        if (arg.toLowerCase() === 'delete' || arg.toLowerCase().startsWith('delete ') || arg.toLowerCase() === 'remove' || arg.toLowerCase().startsWith('remove ')) {
            const remainder = arg.split(' ').slice(1).join(' ').trim();
            if (!remainder) {
                await startInteractiveTimelineDelete(ctx);
                return;
            }

            const shortId = remainder.replace('#', '').trim();
            const event = getWorldEventByShortId(ctx.activeCampaign!.id, shortId);

            if (!event) {
                await ctx.message.reply(t(ctx.locale, 'timeline.eventNotFound', { id: shortId }));
                return;
            }

            const outcome = await deleteEntityFromCommand(ctx, 'timeline', event);
            if (outcome.denied) return;
            if (outcome.ok) {
                await ctx.message.reply(
                    t(ctx.locale, 'timeline.eventDeleted', { id: shortId })
                    + deleteSummaryLine(ctx.locale, outcome.report),
                );
            } else {
                await ctx.message.reply(t(ctx.locale, 'timeline.deleteError', { id: shortId }));
            }
            return;
        }

        // View timeline
        const events = getWorldTimeline(ctx.activeCampaign!.id);

        if (events.length === 0) {
            await ctx.message.reply(t(ctx.locale, 'timeline.empty'));
            return;
        }

        let msg = `${t(ctx.locale, 'timeline.title', { name: ctx.activeCampaign!.name })}\n\n`;

        const icons: Record<string, string> = {
            'WAR': '⚔️',
            'POLITICS': '👑',
            'DISCOVERY': '💎',
            'CALAMITY': '🌋',
            'SUPERNATURAL': '🔮',
            'MYTH': '🏺',
            'RELIGION': '⚜️',
            'BIRTH': '👶',
            'DEATH': '💀',
            'CONSTRUCTION': '🏛️',
            'GENERIC': '🔹'
        };

        events.forEach((e: any) => {
            const icon = icons[e.event_type] || '🔹';
            msg += `\`#${e.short_id}\` **[${yearLabel(ctx.locale, e.year)}]** ${icon} ${e.description}\n`;
        });

        msg += `\n${t(ctx.locale, 'timeline.deleteHint')}`;

        // Handle message length (split if necessary)
        await safeSend(ctx.message.channel as TextChannel, msg);
    }
};
