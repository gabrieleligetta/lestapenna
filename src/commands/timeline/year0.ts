/**
 * $anno0 / $year0 command - Set year 0 event
 */

import { Command, CommandContext } from '../types';
import { setCampaignYear, addWorldEvent } from '../../db';
import { t } from '../../i18n';

export const year0Command: Command = {
    name: 'year0',
    category: 'mondo',
    descriptionKey: 'help.cmd.year0',
    aliases: ['anno0'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const desc = ctx.args.join(' ');
        if (!desc) {
            await ctx.message.reply(t(ctx.locale, 'narrative.year0Usage'));
            return;
        }

        setCampaignYear(ctx.activeCampaign!.id, 0);
        addWorldEvent(ctx.activeCampaign!.id, null, desc, 'GENERIC', 0, true);

        await ctx.message.reply(t(ctx.locale, 'narrative.year0Set', { desc }));
    }
};
