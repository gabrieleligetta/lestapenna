/**
 * $data / $date command - Set or view campaign date
 */

import { Command, CommandContext } from '../types';
import { setCampaignYear } from '../../db';

export const dateCommand: Command = {
    name: 'date',
    aliases: ['data', 'anno', 'year'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const yearStr = ctx.args[0];

        if (!yearStr) {
            const current = ctx.activeCampaign!.current_year;
            const label = current === undefined ? "Non impostata" : (current === 0 ? "Anno 0" : (current > 0 ? `${current} D.E.` : `${Math.abs(current)} P.E.`));
            await ctx.message.reply(`📅 **Data Attuale:** ${label}`);
            return;
        }

        const year = parseInt(yearStr);
        if (isNaN(year)) {
            await ctx.message.reply("Uso: `$data <Numero Anno>` (es. 100 o -50)");
            return;
        }

        setCampaignYear(ctx.activeCampaign!.id, year);
        const label = year === 0 ? "Anno 0" : (year > 0 ? `${year} D.E.` : `${Math.abs(year)} P.E.`);

        // Update local reference
        ctx.activeCampaign!.current_year = year;

        await ctx.message.reply(`📅 Data campagna aggiornata a: **${label}**`);
    }
};
