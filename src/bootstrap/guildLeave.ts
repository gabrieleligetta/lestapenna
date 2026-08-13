import { Client } from 'discord.js';
import { config } from '../config';
import { eraseGuildData } from '../services/dataErasure';
import { disconnect } from '../services/recorder';
import { logger } from '../utils/logger';
import { releaseRecordingCapacity } from '../state/sessionState';

const log = logger('GuildLeave');

/**
 * The bot was removed from a server: erase what was recorded there.
 *
 * Discord's Developer Terms §5(b) require the API Data to be deleted when
 * «retaining it is no longer necessary for your Application's stated
 * functionality» and when «you stop operating your Application», and the
 * Developer Policy (#3) requires respecting «users' ability to remove the
 * Application from spaces where it is present». Removal that leaves every
 * recording, transcript and audio file in place respects the gesture and
 * ignores its meaning.
 *
 * ⚠️ **`guildDelete` does not only mean «removed».**
 *
 * Discord emits this same event when a guild becomes temporarily *unavailable* —
 * an outage on their side, a shard losing a server it still owns. The event is
 * identical; the only thing that distinguishes the two is `guild.available`,
 * which is `false` for an outage and `true` for a real removal.
 *
 * With immediate erasure, getting this wrong is not a bug that produces a wrong
 * answer: it destroys the archives of every table that happened to be connected
 * during a Discord incident, irreversibly and all at once. Hence the guard being
 * the first statement in the handler, and hence the test that pins it.
 */
export function registerGuildLeaveHandler(client: Client) {
    client.on('guildDelete', async (guild) => {
        // See the note above. This is not a defensive nicety.
        if (guild.available === false) {
            log.warn(`Guild ${guild.id} is unavailable (Discord outage), not a removal: erasing nothing.`);
            return;
        }

        if (config.discord.devGuildId && guild.id !== config.discord.devGuildId) {
            log.info(`DEV_GUILD_ID active, ignoring guild ${guild.id}`);
            return;
        }

        if (config.discord.ignoreGuildIds.includes(guild.id)) {
            log.info(`Guild ${guild.id} is in the ignore list, skipping`);
            return;
        }

        log.info(`Removed from guild ${guild.name ?? guild.id} (${guild.id}): erasing its data.`);

        // A recording still running would keep writing files into the very
        // directories about to be swept, and would leave a voice connection open
        // to a guild we are no longer in. `processSession: false` because
        // transcribing and summarising a session for a server that just removed
        // us would spend the table's AI budget producing something nobody can
        // ever read — and would race the erasure while doing it.
        try {
            await disconnect(guild.id, { processSession: false });
        } catch (error) {
            log.warn(`Could not close the recording session: ${(error as Error).message}`);
        } finally {
            await releaseRecordingCapacity(guild.id);
        }

        try {
            const result = await eraseGuildData(guild.id);
            if (result.failedPrefixes.length > 0) {
                log.error(
                    `Erasure of guild ${guild.id} is INCOMPLETE — data survives under: ` +
                    result.failedPrefixes.join(', '),
                );
            }
        } catch (error) {
            // Loud, because the alternative is believing data was deleted when it
            // was not. A failure here needs a human, not a retry.
            log.error(`Erasure of guild ${guild.id} FAILED: data has NOT been deleted`, error as Error);
        }
    });
}
