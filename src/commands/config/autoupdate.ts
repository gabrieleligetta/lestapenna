/**
 * $autoaggiorna / $autoupdate command - Toggle auto-update for character biographies
 */

import { Command, CommandContext } from '../types';
import { setCampaignAutoUpdate } from '../../db';
import { t } from '../../i18n';

export const autoupdateCommand: Command = {
    name: 'autoupdate',
    category: 'admin',
    descriptionKey: 'help.cmd.autoupdate',
    aliases: ['autoaggiorna'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const value = ctx.args[0]?.toLowerCase();

        if (!value || (value !== 'on' && value !== 'off')) {
            await ctx.message.reply(t(ctx.locale, 'config.autoupdateUsage'));
            return;
        }

        const enabled = value === 'on';
        setCampaignAutoUpdate(ctx.activeCampaign!.id, enabled);

        if (enabled) {
            await ctx.message.reply(t(ctx.locale, 'config.autoupdateOn'));
        } else {
            await ctx.message.reply(t(ctx.locale, 'config.autoupdateOff'));
        }
    }
};
