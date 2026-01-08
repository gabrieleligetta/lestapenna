import { VoiceState, VoiceBasedChannel, TextChannel } from 'discord.js';
import { client, guildSessions, autoLeaveTimers } from '../state';
import { disconnect, closeUserStream } from '../../voicerecorder';
import { audioQueue } from '../../queue';
import { getGuildConfig } from '../../db';
import { waitForCompletionAndSummarize } from '../../services/sessionService';

const getCmdChannelId = (guildId: string) => getGuildConfig(guildId, 'cmd_channel_id') || process.env.DISCORD_COMMAND_AND_RESPONSE_CHANNEL_ID;

export async function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;

    const botMember = guild.members.cache.get(client.user!.id);
    const botChannelId = botMember?.voice.channelId;

    // 1. Gestione Auto-Leave del Bot (Esistente)
    if (botMember?.voice.channel) {
        checkAutoLeave(botMember.voice.channel);
    }

    // 2. NUOVO: Gestione Disconnessione Utente (Fix Riconnessione)
    // Se un utente (non bot) lascia il canale dove si trova il bot
    // ORA: Copre sia disconnessione totale che spostamento in altro canale
    if (
        oldState.member && !oldState.member.user.bot && // Non è un bot
        oldState.channelId === botChannelId &&          // Era nel canale del bot
        newState.channelId !== botChannelId             // Non è più nel canale del bot
    ) {
        await closeUserStream(guild.id, oldState.member.id);
    }
}

export function checkAutoLeave(channel: VoiceBasedChannel) {
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

                    const commandChannelId = getCmdChannelId(guildId);
                    if (commandChannelId) {
                        const ch = await client.channels.fetch(commandChannelId) as TextChannel;
                        if (ch) {
                            await ch.send(`👻 Auto-Leave per inattività in <#${channel.id}>. Elaborazione sessione avviata...`);
                            await waitForCompletionAndSummarize(sessionId, ch);
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
