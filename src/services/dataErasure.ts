import * as fs from 'fs';
import * as path from 'path';
import { db, deleteCampaign } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { deleteByPrefix } from './backup';
import { EntityMediaStorage } from './entityMediaStorage';

const log = logger('Erasure');

/**
 * Deleting, for real.
 *
 * Discord's Developer Terms are specific about this — §5(b) requires the API
 * Data to be deleted «promptly» when it is no longer needed for the stated
 * functionality, when the application stops operating, and **when the user asks
 * for it**, and requires users be given «an easily accessible way» to ask.
 *
 * Before this file there was no such way. There was `$wipe`, which is operator
 * only and destroys the whole instance, and `deleteCampaign()`, which ran a
 * single `DELETE FROM campaigns` and trusted cascades that do not exist:
 * `recordings` has no foreign key at all and `sessions.campaign_id` is
 * `ON DELETE SET NULL`, so transcripts and session logs outlived the campaign
 * they belonged to, and nothing at all was removed from object storage.
 *
 * Three scopes, one implementation, because «delete» has to mean the same thing
 * whoever asks:
 *
 *  - {@link eraseGuildData} — a server's whole footprint (bot removed, or asked)
 *  - {@link eraseUserData} — one person's voice and words
 *  - {@link eraseCampaignData} — what `deleteCampaign` always claimed to do
 *
 * Three facts about the storage layout shape everything below:
 *
 *  1. **`recordings` is only reachable through `sessions`.** It carries no
 *     `guild_id` and no foreign key, so every guild-scoped query has to join
 *     `sessions` on `session_id` first.
 *  2. **The object keys are not uniformly scoped.** Raw FLAC lives under
 *     `recordings/{guildId}/{sessionId}/`, but masters and transcripts live
 *     under `recordings/{sessionId}/` and `transcripts/{sessionId}/` with no
 *     guild in the path. Of the picture prefixes, `media/{guildId}/` and
 *     `ai-jobs/{guildId}/` are guild-scoped and `references/{campaignId}/` is
 *     not — so reference images can only be reached by reading the guild's
 *     campaign ids first. So a guild erasure cannot sweep one prefix: it has to
 *     read the guild's session and campaign ids out of the database *first*,
 *     and delete per session and per campaign across all of them. Which is also
 *     why the database rows are deleted **last** — lose the ids and the objects
 *     become unreachable orphans forever.
 *  3. **There are two buckets, and the pictures are in the other one.** Audio,
 *     masters and transcripts live in `OCI_BUCKET_NAME`, which is what
 *     `backup.ts#deleteByPrefix` resolves and the only bucket it can address.
 *     Every picture — uploaded, generated or held for review — lives in
 *     `OCI_MEDIA_BUCKET_NAME`, and is reached through
 *     {@link EntityMediaStorage}. Sweeping a `media/` prefix with the wrong one
 *     silently deletes nothing, which is precisely what this file used to do:
 *     the rows went, the pictures stayed. The two sweep helpers below are kept
 *     separate for that reason, and calling the wrong one is the failure mode to
 *     watch for.
 */

export interface ErasureResult {
    /** Rows removed from the database, per table. Only non-zero entries. */
    rows: Record<string, number>;
    /** Objects removed from OCI. */
    objects: number;
    /** Local files removed. */
    localFiles: number;
    /**
     * Object-storage prefixes that could not be swept. Non-empty means data
     * survives: the caller must say so rather than report a clean deletion.
     */
    failedPrefixes: string[];
}

function emptyResult(): ErasureResult {
    return { rows: {}, objects: 0, localFiles: 0, failedPrefixes: [] };
}

function countRow(result: ErasureResult, table: string, changes: number): void {
    if (changes > 0) result.rows[table] = (result.rows[table] ?? 0) + changes;
}

/**
 * Session ids belonging to a guild. The entry point for everything else.
 *
 * Exported because {@link ../services/dataExport} needs the identical scoping:
 * an export that reached rows the erasure cannot reach — or the reverse — would
 * mean the two disagree about what «your data» is.
 */
export function sessionIdsForGuild(guildId: string): string[] {
    return db.prepare('SELECT session_id FROM sessions WHERE guild_id = ?')
        .all(guildId)
        .map(r => (r as { session_id: string }).session_id);
}

function sessionIdsForCampaign(campaignId: number): string[] {
    return db.prepare('SELECT session_id FROM sessions WHERE campaign_id = ?')
        .all(campaignId)
        .map(r => (r as { session_id: string }).session_id);
}

/**
 * Every prefix under which a session's objects may live.
 *
 * The guild-scoped and the legacy session-scoped raw paths are both listed
 * because both are in the bucket: `backup.ts#getPreferredKey` writes the first
 * when it can resolve the guild and falls back to the second when it cannot.
 * An erasure that only swept the current layout would leave the older uploads
 * behind, which is the failure mode this whole file exists to prevent.
 */
function objectPrefixesForSession(sessionId: string, guildId?: string): string[] {
    const prefixes = [
        `recordings/${sessionId}/`,
        `transcripts/${sessionId}/`,
    ];
    if (guildId) prefixes.unshift(`recordings/${guildId}/${sessionId}/`);
    return prefixes;
}

/**
 * Sweeps prefixes, recording rather than throwing on failure.
 *
 * A prefix that fails must not abort the rest: partial deletion beats none, and
 * the caller needs the list of what survived in order to report it honestly.
 */
async function sweepPrefixes(prefixes: string[], result: ErasureResult): Promise<void> {
    for (const prefix of prefixes) {
        try {
            result.objects += await deleteByPrefix(prefix);
        } catch (error) {
            result.failedPrefixes.push(prefix);
            log.error(`Could not sweep ${prefix}: data survives there`, error as Error);
        }
    }
}

/**
 * The media bucket, or `null` when this instance stores no pictures at all.
 *
 * A disabled or unconfigured media storage is not a failure to report: nothing
 * was ever written there, so nothing survives the erasure.
 */
function mediaStorageOrNull(): EntityMediaStorage | null {
    let storage: EntityMediaStorage;
    try {
        storage = new EntityMediaStorage();
    } catch {
        return null;
    }
    return storage.isEnabled() ? storage : null;
}

/** {@link sweepPrefixes}, against the media bucket. See fact 3 in the file header. */
async function sweepMediaPrefixes(prefixes: string[], result: ErasureResult): Promise<void> {
    if (prefixes.length === 0) return;
    const storage = mediaStorageOrNull();
    if (!storage) return;

    for (const prefix of prefixes) {
        try {
            result.objects += await storage.deleteByPrefix(prefix);
        } catch (error) {
            result.failedPrefixes.push(prefix);
            log.error(`Could not sweep ${prefix} on the media bucket: pictures survive there`, error as Error);
        }
    }
}

/**
 * Named media objects, against the media bucket.
 *
 * By key and not by prefix, because the caller that needs this is erasing one
 * person's uploads out of a campaign that belongs to the whole table.
 */
async function deleteMediaKeys(keys: string[], result: ErasureResult): Promise<void> {
    if (keys.length === 0) return;
    const storage = mediaStorageOrNull();
    if (!storage) return;

    for (const key of keys) {
        if (!key) continue;
        try {
            await storage.delete(key);
            result.objects++;
        } catch (error) {
            result.failedPrefixes.push(key);
            log.error(`Could not delete ${key} on the media bucket`, error as Error);
        }
    }
}

/** Deletes the local FLAC files recorded at the given paths. */
function deleteLocalFiles(filepaths: string[], result: ErasureResult): void {
    for (const filepath of filepaths) {
        if (!filepath) continue;
        // The recorder writes inside recordingsDir and nowhere else. A stored
        // path outside it means a corrupted or hand-edited row, and following it
        // would turn an erasure into an arbitrary file delete.
        const resolved = path.resolve(filepath);
        if (!resolved.startsWith(path.resolve(config.paths.recordingsDir) + path.sep)) {
            log.warn(`Skipping ${filepath}: outside the recordings directory`);
            continue;
        }
        try {
            fs.unlinkSync(resolved);
            result.localFiles++;
        } catch {
            // Already gone: that is the desired state, not an error.
        }
    }
}

/**
 * Erases everything belonging to a guild.
 *
 * Used both by the `guildDelete` handler (the bot was removed) and by the
 * explicit admin command. Order matters: objects first, rows last — see the
 * file header.
 */
export async function eraseGuildData(guildId: string): Promise<ErasureResult> {
    const result = emptyResult();
    const sessionIds = sessionIdsForGuild(guildId);

    log.info(`Erasing guild ${guildId}: ${sessionIds.length} session(s)`);

    // 1. Local audio, read from the rows while they still exist.
    const localPaths = sessionIds.length === 0 ? [] : db.prepare(
        `SELECT filepath FROM recordings WHERE session_id IN (${sessionIds.map(() => '?').join(',')})`,
    ).all(...sessionIds).map(r => (r as { filepath: string }).filepath);
    deleteLocalFiles(localPaths, result);

    // 2. Object storage, on the recordings bucket: per session across every prefix.
    const prefixes: string[] = [];
    for (const sessionId of sessionIds) prefixes.push(...objectPrefixesForSession(sessionId, guildId));
    prefixes.push(`recordings/${guildId}/`);
    await sweepPrefixes(prefixes, result);

    // 3. The pictures, on the media bucket. References carry no guild in their
    // key, so the campaign ids have to be read while the rows still exist.
    const campaignIds = db.prepare('SELECT id FROM campaigns WHERE guild_id = ?')
        .all(guildId).map(row => (row as { id: number }).id);
    const mediaPrefixes = [`media/${guildId}/`, `ai-jobs/${guildId}/`];
    for (const campaignId of campaignIds) mediaPrefixes.push(`references/${campaignId}/`);
    await sweepMediaPrefixes(mediaPrefixes, result);

    // 4. Database, in one transaction: either the guild is gone or it is not.
    db.transaction(() => {
        if (sessionIds.length > 0) {
            const placeholders = sessionIds.map(() => '?').join(',');
            countRow(result, 'recordings', db.prepare(`DELETE FROM recordings WHERE session_id IN (${placeholders})`).run(...sessionIds).changes);
            countRow(result, 'session_notes', db.prepare(`DELETE FROM session_notes WHERE session_id IN (${placeholders})`).run(...sessionIds).changes);
            // session_logs cascades from sessions, which is deleted just below.
        }

        // Campaigns cascade into characters, members, quests, inventory, RAG
        // fragments, entity media, every *_history table and the ask threads
        // (foreign_keys is ON in db/client.ts, so the cascades really do fire).
        countRow(result, 'campaigns', db.prepare('DELETE FROM campaigns WHERE guild_id = ?').run(guildId).changes);
        countRow(result, 'sessions', db.prepare('DELETE FROM sessions WHERE guild_id = ?').run(guildId).changes);
        countRow(result, 'chat_history', db.prepare('DELETE FROM chat_history WHERE guild_id = ?').run(guildId).changes);
        countRow(result, 'ai_usage_log', db.prepare('DELETE FROM ai_usage_log WHERE guild_id = ?').run(guildId).changes);
        countRow(result, 'usage_tracking', db.prepare('DELETE FROM usage_tracking WHERE guild_id = ?').run(guildId).changes);
        countRow(result, 'config', db.prepare('DELETE FROM config WHERE key LIKE ?').run(`guild:${guildId}:%`).changes);
        // The AI credentials of a guild that no longer exists are a liability,
        // not an asset: keeping ciphertext nobody can ever use again is exactly
        // the «no longer necessary» case of §5(b).
        countRow(result, 'tenant_secrets', db.prepare("DELETE FROM tenant_secrets WHERE scope = 'guild' AND scope_id = ?").run(guildId).changes);
        countRow(result, 'tenant_ai_settings', db.prepare("DELETE FROM tenant_ai_settings WHERE scope = 'guild' AND scope_id = ?").run(guildId).changes);
        countRow(result, 'tenants', db.prepare('DELETE FROM tenants WHERE guild_id = ?').run(guildId).changes);
    })();

    log.info(
        `Guild ${guildId} erased: ${result.objects} object(s), ${result.localFiles} local file(s), ` +
        `rows ${JSON.stringify(result.rows)}${result.failedPrefixes.length ? ` — FAILED: ${result.failedPrefixes.join(', ')}` : ''}`,
    );
    return result;
}

/**
 * Erases one person's data within a guild.
 *
 * What goes: their voice, in every form it takes — the audio files, the
 * transcript columns derived from them, their notes, their `$ask` exchanges,
 * their character sheet, the images they uploaded.
 *
 * What stays: the recap, the chronicle and the campaign's world. Those are the
 * table's collective work, they no longer contain anyone's verbatim speech, and
 * erasing them would delete other people's data in order to honour one person's
 * request. `legal_acceptances` also stays — it is the evidence of what was
 * accepted and when, which is the one thing a deletion request cannot be
 * allowed to rewrite.
 */
export async function eraseUserData(guildId: string, userId: string): Promise<ErasureResult> {
    const result = emptyResult();
    const sessionIds = sessionIdsForGuild(guildId);

    log.info(`Erasing user ${userId} on guild ${guildId}`);

    if (sessionIds.length > 0) {
        const placeholders = sessionIds.map(() => '?').join(',');

        // 1. Their audio: local files and objects, located from their own rows.
        const rows = db.prepare(
            `SELECT filename, filepath, session_id FROM recordings
             WHERE user_id = ? AND session_id IN (${placeholders})`,
        ).all(userId, ...sessionIds) as { filename: string; filepath: string; session_id: string }[];

        deleteLocalFiles(rows.map(r => r.filepath), result);

        // One object at a time, not by prefix: the prefix holds the whole
        // table's audio, and this person asked about their own.
        for (const row of rows) {
            for (const prefix of objectPrefixesForSession(row.session_id, guildId)) {
                try {
                    result.objects += await deleteByPrefix(prefix, key => !key.endsWith(`/${row.filename}`));
                } catch (error) {
                    result.failedPrefixes.push(`${prefix}${row.filename}`);
                    log.error(`Could not delete ${prefix}${row.filename}`, error as Error);
                }
            }
        }

        db.transaction(() => {
            countRow(result, 'recordings', db.prepare(
                `DELETE FROM recordings WHERE user_id = ? AND session_id IN (${placeholders})`,
            ).run(userId, ...sessionIds).changes);
            countRow(result, 'session_notes', db.prepare(
                `DELETE FROM session_notes WHERE user_id = ? AND session_id IN (${placeholders})`,
            ).run(userId, ...sessionIds).changes);
        })();
    }

    // 2. Everything else, scoped to this guild's campaigns.
    db.transaction(() => {
        countRow(result, 'characters', db.prepare(
            'DELETE FROM characters WHERE user_id = ? AND campaign_id IN (SELECT id FROM campaigns WHERE guild_id = ?)',
        ).run(userId, guildId).changes);
        countRow(result, 'campaign_members', db.prepare(
            'DELETE FROM campaign_members WHERE user_id = ? AND campaign_id IN (SELECT id FROM campaigns WHERE guild_id = ?)',
        ).run(userId, guildId).changes);
        // ask_messages cascades from ask_conversations.
        countRow(result, 'ask_conversations', db.prepare(
            'DELETE FROM ask_conversations WHERE user_id = ? AND campaign_id IN (SELECT id FROM campaigns WHERE guild_id = ?)',
        ).run(userId, guildId).changes);
        countRow(result, 'chat_history', db.prepare(
            'DELETE FROM chat_history WHERE user_id = ? AND guild_id = ?',
        ).run(userId, guildId).changes);
        countRow(result, 'users', db.prepare('DELETE FROM users WHERE discord_id = ?').run(userId).changes);
    })();

    // 3. Their uploaded pictures, on the media bucket: rows carry the object
    // keys, so read before delete. Both tables, because someone who asks to be
    // forgotten means the reference images they uploaded too — those are the
    // ones most likely to be a photograph of something real.
    const mediaKeys = db.prepare(
        `SELECT display_object_key, thumbnail_object_key FROM entity_media
         WHERE uploaded_by = ? AND campaign_id IN (SELECT id FROM campaigns WHERE guild_id = ?)`,
    ).all(userId, guildId) as { display_object_key: string; thumbnail_object_key: string }[];
    const referenceKeys = db.prepare(
        `SELECT object_key FROM reference_image
         WHERE uploaded_by = ? AND campaign_id IN (SELECT id FROM campaigns WHERE guild_id = ?)`,
    ).all(userId, guildId) as { object_key: string }[];

    await deleteMediaKeys([
        ...mediaKeys.flatMap(media => [media.display_object_key, media.thumbnail_object_key]),
        ...referenceKeys.map(reference => reference.object_key),
    ], result);

    countRow(result, 'entity_media', db.prepare(
        'DELETE FROM entity_media WHERE uploaded_by = ? AND campaign_id IN (SELECT id FROM campaigns WHERE guild_id = ?)',
    ).run(userId, guildId).changes);
    countRow(result, 'reference_image', db.prepare(
        'DELETE FROM reference_image WHERE uploaded_by = ? AND campaign_id IN (SELECT id FROM campaigns WHERE guild_id = ?)',
    ).run(userId, guildId).changes);

    log.info(
        `User ${userId} erased on guild ${guildId}: ${result.objects} object(s), ` +
        `${result.localFiles} local file(s), rows ${JSON.stringify(result.rows)}`,
    );
    return result;
}

/**
 * Erases a campaign, including the parts `deleteCampaign()` used to leave behind.
 *
 * The campaign row itself cascades widely, but `recordings` and `sessions` do
 * not follow it — `sessions.campaign_id` is `ON DELETE SET NULL`, which turned
 * every deleted campaign's sessions into orphans that no later cleanup could
 * attribute to anyone.
 */
export async function eraseCampaignData(campaignId: number): Promise<ErasureResult> {
    const result = emptyResult();
    const guildRow = db.prepare('SELECT guild_id FROM campaigns WHERE id = ?').get(campaignId) as { guild_id: string } | undefined;
    const sessionIds = sessionIdsForCampaign(campaignId);

    log.info(`Erasing campaign ${campaignId}: ${sessionIds.length} session(s)`);

    if (sessionIds.length > 0) {
        const placeholders = sessionIds.map(() => '?').join(',');
        const localPaths = db.prepare(
            `SELECT filepath FROM recordings WHERE session_id IN (${placeholders})`,
        ).all(...sessionIds).map(r => (r as { filepath: string }).filepath);
        deleteLocalFiles(localPaths, result);

        const prefixes: string[] = [];
        for (const sessionId of sessionIds) prefixes.push(...objectPrefixesForSession(sessionId, guildRow?.guild_id));
        await sweepPrefixes(prefixes, result);
    }

    // The pictures, on the media bucket, before the rows go: the cascade takes
    // `entity_media` and `reference_image` with the campaign, and an object
    // whose row no longer exists is an orphan nothing can ever reach again.
    const mediaPrefixes = [`references/${campaignId}/`];
    if (guildRow) {
        mediaPrefixes.push(`media/${guildRow.guild_id}/${campaignId}/`, `ai-jobs/${guildRow.guild_id}/${campaignId}/`);
    }
    await sweepMediaPrefixes(mediaPrefixes, result);

    // The row deletion lives in the repository, which is where the schema's
    // missing cascades are documented and fixed. Duplicating it here would mean
    // two definitions of «delete a campaign», free to drift apart.
    deleteCampaign(campaignId);
    countRow(result, 'campaigns', 1);
    countRow(result, 'sessions', sessionIds.length);

    log.info(
        `Campaign ${campaignId} erased: ${result.objects} object(s), ` +
        `${result.localFiles} local file(s), rows ${JSON.stringify(result.rows)}`,
    );
    return result;
}
