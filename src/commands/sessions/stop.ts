import { TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { disconnect } from '../../services/recorder';
import { waitForCompletionAndSummarize } from '../../publisher';
import { getActiveSession, deleteActiveSession, decrementRecordingCount } from '../../state/sessionState';

export const stopCommand: Command = {
    name: 'stop',
    aliases: ['termina', 'stoplistening'],
    requiresCampaign: false, // Can stop even if campaign context is loose? Probably requires session check.

    async execute(ctx: CommandContext): Promise<void> {
        const { message, client } = ctx;
        const sessionId = await getActiveSession(message.guild!.id);

        if (!sessionId) {
            // Disconnect anyway if requested, just to be safe
            await disconnect(message.guild!.id);
            await message.reply("Nessuna sessione attiva tracciata, ma mi sono disconnesso.");
            return;
        }

        // 1. Disconnessione e chiusura file
        await disconnect(message.guild!.id);
        await deleteActiveSession(message.guild!.id);

        const stopMsg = `🛑 Sessione **${sessionId}** terminata. Lo Scriba sta trascrivendo...`;
        if (ctx.interaction && !ctx.interaction.replied && !ctx.interaction.deferred) {
            await ctx.interaction.update({ content: stopMsg, components: [], embeds: [] });
        } else {
            await message.reply(stopMsg);
        }

        // 2. Ripresa coda (per-session: decrementa contatore, resume se nessuno registra)
        await decrementRecordingCount();
        console.log(`[Flow] Contatore recording decrementato. I worker elaboreranno i file accumulati...`);

        // 3. Monitoraggio
        await waitForCompletionAndSummarize(client, sessionId, message.channel as TextChannel);
    }
};
