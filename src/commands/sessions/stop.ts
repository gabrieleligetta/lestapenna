import { TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { disconnect } from '../../voicerecorder';
import { audioQueue } from '../../queue';
import { waitForCompletionAndSummarize } from '../../utils/publish';
// @ts-ignore
import { guildSessions } from '../../index'; // Accessing global state

export const stopCommand: Command = {
    name: 'stop',
    aliases: ['termina', 'stoplistening'],
    requiresCampaign: false, // Can stop even if campaign context is loose? Probably requires session check.

    async execute(ctx: CommandContext): Promise<void> {
        const { message, client } = ctx;
        const sessionId = guildSessions.get(message.guild!.id);

        if (!sessionId) {
            // Disconnect anyway if requested, just to be safe
            await disconnect(message.guild!.id);
            await message.reply("Nessuna sessione attiva tracciata, ma mi sono disconnesso.");
            return;
        }

        // 1. Disconnessione e chiusura file
        await disconnect(message.guild!.id);
        guildSessions.delete(message.guild!.id);

        await message.reply(`🛑 Sessione **${sessionId}** terminata. Lo Scriba sta trascrivendo...`);

        // 2. Ripresa coda
        await audioQueue.resume();
        console.log(`[Flow] Coda RIPRESA. I worker stanno elaborando i file accumulati...`);

        // 3. Monitoraggio
        await waitForCompletionAndSummarize(client, sessionId, message.channel as TextChannel);
    }
};
