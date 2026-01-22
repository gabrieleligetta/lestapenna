/**
 * $autoaggiorna / $autoupdate command - Toggle auto-update for character biographies
 */

import { Command, CommandContext } from '../types';
import { setCampaignAutoUpdate } from '../../db';

export const autoupdateCommand: Command = {
    name: 'autoupdate',
    aliases: ['autoaggiorna'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const value = ctx.args[0]?.toLowerCase();

        if (!value || (value !== 'on' && value !== 'off')) {
            await ctx.message.reply("Uso: `$autoaggiorna on` o `$autoaggiorna off`");
            return;
        }

        const enabled = value === 'on';
        setCampaignAutoUpdate(ctx.activeCampaign!.id, enabled);

        if (enabled) {
            await ctx.message.reply("✅ **Auto-aggiornamento Biografie PG attivato.**\nLe biografie dei personaggi verranno aggiornate automaticamente dopo ogni sessione.");
        } else {
            await ctx.message.reply("⏸️ **Auto-aggiornamento Biografie PG disattivato.**\nLe biografie non verranno più aggiornate automaticamente.");
        }
    }
};
