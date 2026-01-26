import { Client, VoiceBasedChannel, TextChannel } from 'discord.js';
import { guildSessions, autoLeaveTimers } from '../state/sessionState';
// import { checkAutoLeave } from './voiceState'; // Recursion? No, defining local helper or export.
import { audioQueue } from '../services/queue';
import { disconnect } from '../services/recorder';
import { getGuildConfig } from '../db';
import { waitForCompletionAndSummarize } from '../publisher'; // Assuming publish has it or I move logic here

export function registerVoiceStateHandler(client: Client) {
    client.on('voiceStateUpdate', (oldState, newState) => {
        const guild = newState.guild || oldState.guild;
        if (!guild) return;
        const botMember = guild.members.cache.get(client.user!.id);
        if (!botMember?.voice.channel) return;
        checkAutoLeave(botMember.voice.channel, client);

    });
}

// Export as checkAutoLeave for compatibility/external usage
export async function checkAutoLeave(channel: VoiceBasedChannel, client: Client) {
    const humans = channel.members.filter(member => !member.user.bot).size;

    const guildId = channel.guild.id;

    if (humans === 0) {
        if (!autoLeaveTimers.has(guildId)) {
            console.log(`👻 Canale vuoto in ${guildId}. Timer 60s...`);
            const timer = setTimeout(async () => {
                const sessionId = guildSessions.get(guildId);
                if (sessionId) {
                    await disconnect(guildId);
                    guildSessions.delete(guildId);
                    await audioQueue.resume();

                    const commandChannelId = getGuildConfig(guildId, 'cmd_channel_id');
                    if (commandChannelId) {
                        const ch = await client.channels.fetch(commandChannelId) as TextChannel;
                        if (ch) {
                            await ch.send(`👻 Auto-Leave per inattività in <#${channel.id}>. Elaborazione sessione avviata...`);
                            // waitForCompletionAndSummarize needs to be available
                            // I'll assume imported from utils/publish
                            await waitForCompletionAndSummarize(client, sessionId, ch);
                        }
                    }
                } else {
                    await disconnect(guildId);
                }
                autoLeaveTimers.delete(guildId);
            }, 60000);
            autoLeaveTimers.set(guildId, timer);
        }
    } else {
        const timer = autoLeaveTimers.get(guildId);
        if (timer) {
            clearTimeout(timer);
            autoLeaveTimers.delete(guildId);
        }
    }
}
