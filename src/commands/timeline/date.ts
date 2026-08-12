/**
 * $data / $date command - Set or view campaign date
 */

import { Command, CommandContext } from '../types';
import { setCampaignYear } from '../../db';
import { t, yearLabel } from '../../i18n';

export const dateCommand: Command = {
    name: 'date',
    category: 'mondo',
    descriptionKey: 'help.cmd.date',
    aliases: ['data', 'anno', 'year'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const yearStr = ctx.args[0];

        if (!yearStr) {
            const current = ctx.activeCampaign!.current_year;
            await ctx.message.reply(t(ctx.locale, 'narrative.currentDate', { label: yearLabel(ctx.locale, current) }));
            return;
        }

        const year = parseInt(yearStr);
        if (isNaN(year)) {
            await ctx.message.reply(t(ctx.locale, 'narrative.dateUsage'));
            return;
        }

        setCampaignYear(ctx.activeCampaign!.id, year);

        // Update local reference
        ctx.activeCampaign!.current_year = year;

        await ctx.message.reply(t(ctx.locale, 'narrative.dateUpdated', { label: yearLabel(ctx.locale, year) }));
    }
};
