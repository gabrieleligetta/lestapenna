/**
 * Session Hard Cap — technical 10h safety stop for a single recording.
 *
 * It is a technical protection, not a commercial limit: without it a voice
 * channel left open by mistake would record forever, filling the disk and
 * producing an unaffordable transcription on the user's provider account.
 * It follows the same pattern as the auto-leave timer in bootstrap/voiceState.ts.
 */

import { Client, TextChannel } from 'discord.js';
import { disconnect } from './recorder';
import { getActiveSession, deleteActiveSession, decrementRecordingCount } from '../state/sessionState';
import { getGuildConfig } from '../db';
import { logger } from '../utils/logger';
import { launchSessionProcessing } from './sessionProcessing';

const log = logger('SessionHardCap');

/** Technical duration cap for a single recording (10 hours). */
export const SESSION_HARD_CAP_MINUTES = 600;

const hardCapTimers = new Map<string, NodeJS.Timeout>();

/**
 * Schedules the automatic stop for a session once it reaches the technical
 * 10h cap. No-ops (replacing any previous timer) if called again for the
 * same guild — e.g. a new session starting after the previous one ended.
 */
export function scheduleSessionHardCap(guildId: string, sessionId: string, client: Client): void {
    clearSessionHardCap(guildId);

    const timer = setTimeout(async () => {
        hardCapTimers.delete(guildId);

        // The session may already have ended (manual stop, auto-leave).
        const active = await getActiveSession(guildId);
        if (active !== sessionId) return;

        log.warn(`Sessione ${sessionId}: limite tecnico di ${SESSION_HARD_CAP_MINUTES} minuti raggiunto, arresto automatico.`);

        await deleteActiveSession(guildId);
        try {
            await disconnect(guildId, { processSession: false });
        } finally {
            await decrementRecordingCount(guildId);
        }

        const commandChannelId = getGuildConfig(guildId, 'cmd_channel_id');
        let channel: TextChannel | undefined;
        if (commandChannelId) {
            try {
                channel = await client.channels.fetch(commandChannelId) as TextChannel;
                if (channel) {
                    await channel.send(`⏱️ Limite tecnico di sessione (${SESSION_HARD_CAP_MINUTES / 60}h) raggiunto. Elaborazione avviata automaticamente.`);
                }
            } catch {
                log.warn(`Impossibile accedere al canale comandi ${commandChannelId}`);
            }
        }

        if (channel) launchSessionProcessing(sessionId, guildId, channel.id);
        else launchSessionProcessing(sessionId, guildId);
    }, SESSION_HARD_CAP_MINUTES * 60 * 1000);

    hardCapTimers.set(guildId, timer);
}

/** Cancels the pending hard-cap timer for a guild (session ended by other means). */
export function clearSessionHardCap(guildId: string): void {
    const timer = hardCapTimers.get(guildId);
    if (timer) {
        clearTimeout(timer);
        hardCapTimers.delete(guildId);
    }
}
