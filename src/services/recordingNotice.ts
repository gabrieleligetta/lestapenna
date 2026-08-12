import { ActivityType, Guild, TextChannel, VoiceChannel } from 'discord.js';
import { db } from '../db/client';
import { t } from '../i18n';
import type { Locale } from '../i18n';
import { config } from '../config';
import { logger } from '../utils/logger';

const log = logger('RecordingNotice');

/**
 * Making it obvious that recording is happening.
 *
 * It is the most delicate processing in the whole project: the people being
 * recorded are the players in the voice channel, and almost none of them will
 * ever open the web app or read the terms. A checkbox ticked by whoever logs in
 * does not collect their consent — at most that of a single person.
 *
 * So the notice has to be given **where those people are**, that is on Discord, and
 * in several ways at once because nobody looks at everything:
 *
 *  1. **the bot's nickname** becomes `[REC] …`, visible in the voice channel's
 *     user list for the whole duration;
 *  2. **a message in the channel**, with what is recorded, what is done with it and how
 *     to opt out. In full the first time, in short form afterwards;
 *  3. **the bot's status** says that it is recording.
 *
 * ⚠️ **If the nickname cannot be changed, there is no recording.** It is the choice made by
 * Craig, the most widely used recording bot in this niche, and it is the right one: an
 * indicator that can be silenced is not an indicator. The missing permission is
 * `Change Nickname`, and the error message says so.
 */

const REC_PREFIX = '[REC] ';
/** Discord truncates nicknames at 32 characters: the prefix has to fit inside that. */
const MAX_NICKNAME = 32;

/**
 * Puts the bot into the «I am recording» state.
 *
 * Returns `false` when it could not: the caller must not proceed.
 */
export async function markRecording(guild: Guild, voiceChannel: VoiceChannel): Promise<boolean> {
    const me = guild.members.me;
    if (!me) return false;

    const base = (me.nickname ?? me.user.username).replace(REC_PREFIX, '');
    const marked = (REC_PREFIX + base).slice(0, MAX_NICKNAME);

    try {
        await me.setNickname(marked, 'Sessione di registrazione avviata');
    } catch (error) {
        log.warn(
            'Impossibile marcare il soprannome: senza indicatore visibile la ' +
            `registrazione non parte. (${(error as Error).message})`,
            { guildId: guild.id },
        );
        return false;
    }

    try {
        guild.client.user?.setActivity(`🔴 ${voiceChannel.name}`, { type: ActivityType.Listening });
    } catch {
        // The status is a reinforcement, not the main indicator: if it fails we
        // carry on anyway, the nickname is there.
    }
    return true;
}

/** Puts the bot back as it was. It never fails the caller. */
export async function clearRecording(guild: Guild): Promise<void> {
    const me = guild.members.me;
    if (!me) return;

    try {
        const stripped = (me.nickname ?? '').replace(REC_PREFIX, '').trim();
        await me.setNickname(stripped || null, 'Sessione di registrazione terminata');
    } catch (error) {
        log.warn(`Impossibile ripulire il soprannome: ${(error as Error).message}`, { guildId: guild.id });
    }
    try {
        guild.client.user?.setActivity();
    } catch { /* nothing to do */ }
}

/**
 * The in-channel notice.
 *
 * In full the first time on that server, in short form afterwards. The long
 * version repeated at every session becomes noise nobody reads any more, which is
 * worse than a short notice that is read.
 */
export async function announceRecording(
    guild: Guild,
    channel: TextChannel,
    voiceChannel: VoiceChannel,
    locale: Locale,
): Promise<void> {
    const row = db.prepare('SELECT recording_notice_at FROM tenants WHERE guild_id = ?')
        .get(guild.id) as { recording_notice_at: number | null } | undefined;
    const isFirstTime = !row?.recording_notice_at;

    try {
        await channel.send(t(locale, isFirstTime ? 'recording.noticeFull' : 'recording.noticeShort', {
            channel: voiceChannel.name,
            // The instance's own policy, not the maintainer's: this message
            // collects the consent of the people in the voice channel, and
            // sending them to a document describing somebody else's processing
            // is exactly how you collect it badly.
            //
            // The angle brackets live here and not in the translations: they
            // suppress Discord's link preview (a big card in the middle of a
            // legal notice makes it look like an ad), and that is a rendering
            // choice, not something every language must remember to write.
            url: `<${config.discordOAuth.publicBaseUrl}/privacy>`,
        }));
    } catch (error) {
        log.warn(`Impossibile pubblicare l'avviso di registrazione: ${(error as Error).message}`, { guildId: guild.id });
        return;
    }

    if (isFirstTime) {
        db.prepare(
            'INSERT INTO tenants (guild_id, recording_notice_at) VALUES (?, ?) ' +
            'ON CONFLICT(guild_id) DO UPDATE SET recording_notice_at = excluded.recording_notice_at',
        ).run(guild.id, Date.now());
    }
}
