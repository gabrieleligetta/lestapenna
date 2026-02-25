import { Client, VoiceBasedChannel, TextChannel } from 'discord.js';
import { getActiveSession, deleteActiveSession, decrementRecordingCount, autoLeaveTimers } from '../state/sessionState';
import { disconnect } from '../services/recorder';
import { getGuildConfig } from '../db';
import { waitForCompletionAndSummarize } from '../publisher';
import { config } from '../config';

export function registerVoiceStateHandler(client: Client) {
    client.on('voiceStateUpdate', (oldState, newState) => {
        const guild = newState.guild || oldState.guild;
        if (!guild) return;

        // DEV_GUILD_ID: If set, only handle that specific guild
        if (config.discord.devGuildId && guild.id !== config.discord.devGuildId) {
            return;
        }

        // IGNORE_GUILD_IDS: Skip these guilds
        if (config.discord.ignoreGuildIds.includes(guild.id)) {
            return;
        }

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
                const sessionId = await getActiveSession(guildId);
                if (sessionId) {
                    // Rimuovi la sessione da Redis SUBITO — previene la race condition con $termina
                    await deleteActiveSession(guildId);
                    await decrementRecordingCount();
                    await disconnect(guildId);

                    // Try to get command channel for notifications (optional)
                    const commandChannelId = getGuildConfig(guildId, 'cmd_channel_id');
                    let ch: TextChannel | undefined;
                    if (commandChannelId) {
                        try {
                            ch = await client.channels.fetch(commandChannelId) as TextChannel;
                            if (ch) {
                                await ch.send(`👻 Auto-Leave per inattività in <#${channel.id}>. Elaborazione sessione avviata...`);
                            }
                        } catch (e) {
                            console.warn(`⚠️ Impossibile accedere al canale comandi ${commandChannelId}`);
                        }
                    }
                    // Always process the session, even without a notification channel
                    await waitForCompletionAndSummarize(client, sessionId, ch);
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
