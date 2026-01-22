/**
 * $anno0 / $year0 command - Set year 0 event
 */

import { Command, CommandContext } from '../types';
import { setCampaignYear, addWorldEvent } from '../../db';

export const year0Command: Command = {
    name: 'year0',
    aliases: ['anno0'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const desc = ctx.args.join(' ');
        if (!desc) {
            await ctx.message.reply("Uso: `$anno0 <Descrizione Evento Cardine>` (es. 'La Caduta dell'Impero')");
            return;
        }

        setCampaignYear(ctx.activeCampaign!.id, 0);
        addWorldEvent(ctx.activeCampaign!.id, null, desc, 'GENERIC', 0);

        await ctx.message.reply(`📅 **Anno 0 Stabilito!**\nEvento: *${desc}*\nOra puoi usare \`$data <Anno>\` per impostare la data corrente.`);
    }
};
