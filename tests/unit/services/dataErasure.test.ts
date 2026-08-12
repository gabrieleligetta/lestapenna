/**
 * Erasing data, and the one case where erasing would be a catastrophe.
 *
 * Discord's Developer Terms §5(b) require API Data to be deleted when it is no
 * longer needed, when the application stops operating and when the user asks.
 * These tests pin the three scopes, and — above all — the guard that stops a
 * Discord outage from being mistaken for a removal.
 */

import { wipeDatabase } from '../../../src/db/maintenance';
import { db } from '../../../src/db';

// Object storage is mocked: these tests are about which rows and which keys are
// chosen, not about whether the S3 client works.
//
// **Two mocks, one per bucket, and that is the point.** Audio lives in
// `OCI_BUCKET_NAME` and pictures in `OCI_MEDIA_BUCKET_NAME`; a single mock would
// pass whichever bucket the code addressed, which is how the erasure paths came
// to sweep every `media/` prefix against the recordings bucket and delete
// nothing at all. Asserting that a key reached *this* mock and not *that* one is
// the only assertion that can tell the two apart.
const deleteByPrefixMock = jest.fn(async (_prefix: string, _keep?: unknown) => 1);
jest.mock('../../../src/services/backup', () => ({
    deleteByPrefix: (prefix: string, keep?: unknown) => deleteByPrefixMock(prefix, keep),
}));

const mockMediaSweep = jest.fn(async (_prefix: string) => 1);
const mockMediaDelete = jest.fn(async (_key: string) => undefined);
jest.mock('../../../src/services/entityMediaStorage', () => ({
    EntityMediaStorage: jest.fn().mockImplementation(() => ({
        isEnabled: () => true,
        deleteByPrefix: (prefix: string) => mockMediaSweep(prefix),
        delete: (key: string) => mockMediaDelete(key),
    })),
}));

import * as path from 'path';
import { eraseCampaignData, eraseGuildData, eraseUserData } from '../../../src/services/dataErasure';
import { exportUserData } from '../../../src/services/dataExport';
import { config } from '../../../src/config';

const GUILD = 'guild-erasure';
const OTHER_GUILD = 'guild-untouched';
const USER = 'user-asking';
const OTHER_USER = 'user-staying';

/**
 * A guild with a campaign, a session and one recording per user.
 * Returns the campaign id, which most assertions need.
 */
function seedGuild(guildId: string, sessionId: string): number {
    db.prepare('INSERT INTO campaigns (guild_id, name, is_active, created_at) VALUES (?, ?, 1, ?)')
        .run(guildId, `Campaign ${guildId}`, Date.now());
    const campaignId = db.prepare('SELECT id FROM campaigns WHERE guild_id = ?').get(guildId) as { id: number };

    db.prepare('INSERT INTO sessions (session_id, session_number, guild_id, campaign_id) VALUES (?, 1, ?, ?)')
        .run(sessionId, guildId, campaignId.id);

    for (const userId of [USER, OTHER_USER]) {
        // `filename` is unique across the table, so it has to carry the session.
        // The path sits inside recordingsDir on purpose: outside it the erasure
        // refuses to follow the path, and the test would exercise the guard
        // instead of the deletion.
        const filename = `${sessionId}-${userId}.flac`;
        db.prepare(
            `INSERT INTO recordings (session_id, filename, filepath, user_id, timestamp, status, transcription_text)
             VALUES (?, ?, ?, ?, ?, 'PROCESSED', ?)`,
        ).run(
            sessionId, filename, path.join(config.paths.recordingsDir, filename),
            userId, Date.now(), `what ${userId} said`,
        );
        db.prepare('INSERT INTO characters (user_id, campaign_id, character_name) VALUES (?, ?, ?)')
            .run(userId, campaignId.id, `PC of ${userId}`);
        db.prepare('INSERT INTO session_notes (session_id, user_id, content, timestamp) VALUES (?, ?, ?, ?)')
            .run(sessionId, userId, `note by ${userId}`, Date.now());
        db.prepare('INSERT INTO chat_history (channel_id, role, content, timestamp, guild_id, user_id) VALUES (?, ?, ?, ?, ?, ?)')
            .run('channel-1', 'user', `question from ${userId}`, Date.now(), guildId, userId);
    }

    db.prepare('INSERT INTO session_logs (session_id, content) VALUES (?, ?)').run(sessionId, 'the log');
    return campaignId.id;
}

/**
 * A gallery picture and a reference picture uploaded by `userId`.
 *
 * Two tables and not one: `entity_media` is the portrait on the sheet and
 * `reference_image` is the picture handed to the image model, they are erased
 * through different paths, and only the second is the kind most likely to be a
 * photograph of something that belongs to somebody else.
 */
function seedPictures(campaignId: number, guildId: string, userId: string): { media: string[]; reference: string } {
    const media = [
        `media/${guildId}/${campaignId}/npc/${userId}/display.webp`,
        `media/${guildId}/${campaignId}/npc/${userId}/thumbnail.webp`,
    ];
    db.prepare(
        `INSERT INTO entity_media (id, campaign_id, entity_type, entity_key, display_object_key,
             thumbnail_object_key, width, height, size_bytes, uploaded_by, created_at, updated_at)
         VALUES (?, ?, 'npc', ?, ?, ?, 800, 600, 1234, ?, ?, ?)`,
    ).run(`media-${guildId}-${userId}`, campaignId, `npc-${userId}`, media[0], media[1], userId, Date.now(), Date.now());

    const reference = `references/${campaignId}/campaign/${userId}.webp`;
    db.prepare(
        `INSERT INTO reference_image (id, campaign_id, scope, scope_key, object_key, mime_type,
             width, height, size_bytes, uploaded_by, created_at)
         VALUES (?, ?, 'campaign', '', ?, 'image/webp', 800, 600, 1234, ?, ?)`,
    ).run(`ref-${guildId}-${userId}`, campaignId, reference, userId, Date.now());

    return { media, reference };
}

beforeEach(() => {
    wipeDatabase();
    deleteByPrefixMock.mockClear();
    mockMediaSweep.mockClear();
    mockMediaDelete.mockClear();
});

describe('eraseGuildData', () => {
    it('leaves nothing of the guild behind', async () => {
        seedGuild(GUILD, 'session-a');

        await eraseGuildData(GUILD);

        expect(db.prepare('SELECT COUNT(*) c FROM recordings').get()).toEqual({ c: 0 });
        expect(db.prepare('SELECT COUNT(*) c FROM sessions WHERE guild_id = ?').get(GUILD)).toEqual({ c: 0 });
        expect(db.prepare('SELECT COUNT(*) c FROM session_logs').get()).toEqual({ c: 0 });
        expect(db.prepare('SELECT COUNT(*) c FROM session_notes').get()).toEqual({ c: 0 });
        expect(db.prepare('SELECT COUNT(*) c FROM campaigns WHERE guild_id = ?').get(GUILD)).toEqual({ c: 0 });
        expect(db.prepare('SELECT COUNT(*) c FROM characters').get()).toEqual({ c: 0 });
        expect(db.prepare('SELECT COUNT(*) c FROM chat_history WHERE guild_id = ?').get(GUILD)).toEqual({ c: 0 });
    });

    it('sweeps the guild-scoped and the legacy session-scoped prefixes alike', async () => {
        seedGuild(GUILD, 'session-a');

        await eraseGuildData(GUILD);

        const swept = deleteByPrefixMock.mock.calls.map(call => call[0]);
        // Raw audio moved from a session-scoped path to a guild-scoped one, and
        // both layouts are in the bucket: sweeping only the current one would
        // leave the older uploads sitting there.
        expect(swept).toContain(`recordings/${GUILD}/session-a/`);
        expect(swept).toContain('recordings/session-a/');
        expect(swept).toContain('transcripts/session-a/');
    });

    it('sweeps the pictures on the media bucket, and never on the recordings one', async () => {
        const campaignId = seedGuild(GUILD, 'session-a');
        seedPictures(campaignId, GUILD, USER);

        await eraseGuildData(GUILD);

        const media = mockMediaSweep.mock.calls.map(call => call[0]);
        expect(media).toContain(`media/${GUILD}/`);
        expect(media).toContain(`ai-jobs/${GUILD}/`);
        // References carry the campaign in the key and no guild at all, so they
        // are reachable only through the campaign ids — read while the rows are
        // still there. Miss this and the pictures outlive the server that had them.
        expect(media).toContain(`references/${campaignId}/`);

        // The regression: every one of those used to go to the recordings
        // bucket, where no picture has ever been written.
        expect(deleteByPrefixMock.mock.calls.map(call => call[0])).not.toContain(`media/${GUILD}/`);
    });

    it('reports a media bucket it could not sweep', async () => {
        seedGuild(GUILD, 'session-a');
        mockMediaSweep.mockRejectedValueOnce(new Error('media storage unreachable'));

        const result = await eraseGuildData(GUILD);

        expect(result.failedPrefixes).toContain(`media/${GUILD}/`);
    });

    it('does not touch another guild', async () => {
        seedGuild(GUILD, 'session-a');
        seedGuild(OTHER_GUILD, 'session-b');

        await eraseGuildData(GUILD);

        expect(db.prepare('SELECT COUNT(*) c FROM campaigns WHERE guild_id = ?').get(OTHER_GUILD)).toEqual({ c: 1 });
        expect(db.prepare('SELECT COUNT(*) c FROM recordings WHERE session_id = ?').get('session-b')).toEqual({ c: 2 });
    });

    it('reports the prefixes it could not sweep instead of claiming success', async () => {
        seedGuild(GUILD, 'session-a');
        deleteByPrefixMock.mockRejectedValueOnce(new Error('storage unreachable'));

        const result = await eraseGuildData(GUILD);

        expect(result.failedPrefixes.length).toBeGreaterThan(0);
    });
});

describe('eraseUserData', () => {
    it('takes the asker’s voice and leaves everyone else’s', async () => {
        seedGuild(GUILD, 'session-a');

        await eraseUserData(GUILD, USER);

        const left = db.prepare('SELECT user_id FROM recordings').all() as { user_id: string }[];
        expect(left).toEqual([{ user_id: OTHER_USER }]);
        expect(db.prepare('SELECT COUNT(*) c FROM characters WHERE user_id = ?').get(USER)).toEqual({ c: 0 });
        expect(db.prepare('SELECT COUNT(*) c FROM characters WHERE user_id = ?').get(OTHER_USER)).toEqual({ c: 1 });
        expect(db.prepare('SELECT COUNT(*) c FROM chat_history WHERE user_id = ?').get(USER)).toEqual({ c: 0 });
        expect(db.prepare('SELECT COUNT(*) c FROM chat_history WHERE user_id = ?').get(OTHER_USER)).toEqual({ c: 1 });
    });

    it('leaves the shared campaign standing', async () => {
        seedGuild(GUILD, 'session-a');

        await eraseUserData(GUILD, USER);

        // Erasing one person's data must not delete the table's collective work:
        // that would honour one request by destroying everyone else's.
        expect(db.prepare('SELECT COUNT(*) c FROM campaigns WHERE guild_id = ?').get(GUILD)).toEqual({ c: 1 });
        expect(db.prepare('SELECT COUNT(*) c FROM sessions WHERE guild_id = ?').get(GUILD)).toEqual({ c: 1 });
        expect(db.prepare('SELECT COUNT(*) c FROM session_logs').get()).toEqual({ c: 1 });
    });

    it('takes the pictures they uploaded, on the media bucket, and leaves the others', async () => {
        const campaignId = seedGuild(GUILD, 'session-a');
        const mine = seedPictures(campaignId, GUILD, USER);
        const theirs = seedPictures(campaignId, GUILD, OTHER_USER);

        await eraseUserData(GUILD, USER);

        const deleted = mockMediaDelete.mock.calls.map(call => call[0]);
        expect(deleted).toEqual(expect.arrayContaining([...mine.media, mine.reference]));
        expect(deleted).not.toContain(theirs.media[0]);
        expect(deleted).not.toContain(theirs.reference);

        expect(db.prepare('SELECT uploaded_by FROM entity_media').all()).toEqual([{ uploaded_by: OTHER_USER }]);
        // `reference_image` was not consulted by this path at all: someone who
        // asked to be forgotten kept every reference picture they had uploaded.
        expect(db.prepare('SELECT uploaded_by FROM reference_image').all()).toEqual([{ uploaded_by: OTHER_USER }]);
    });
});

describe('eraseCampaignData', () => {
    it('takes the recordings and the sessions with it', async () => {
        const campaignId = seedGuild(GUILD, 'session-a');

        await eraseCampaignData(campaignId);

        // The regression this exists for: `sessions.campaign_id` is
        // ON DELETE SET NULL and `recordings` has no foreign key at all, so a
        // plain DELETE FROM campaigns left both — with the transcripts inside.
        expect(db.prepare('SELECT COUNT(*) c FROM campaigns WHERE id = ?').get(campaignId)).toEqual({ c: 0 });
        expect(db.prepare('SELECT COUNT(*) c FROM sessions').get()).toEqual({ c: 0 });
        expect(db.prepare('SELECT COUNT(*) c FROM recordings').get()).toEqual({ c: 0 });
        expect(db.prepare('SELECT COUNT(*) c FROM session_logs').get()).toEqual({ c: 0 });
        expect(db.prepare('SELECT COUNT(*) c FROM session_notes').get()).toEqual({ c: 0 });
    });

    it('takes the campaign’s pictures with it instead of orphaning them', async () => {
        const campaignId = seedGuild(GUILD, 'session-a');
        seedPictures(campaignId, GUILD, USER);

        await eraseCampaignData(campaignId);

        const media = mockMediaSweep.mock.calls.map(call => call[0]);
        // This path swept no picture prefix at all: the cascade took the rows
        // holding the object keys, leaving objects nothing could ever reach.
        expect(media).toContain(`references/${campaignId}/`);
        expect(media).toContain(`media/${GUILD}/${campaignId}/`);
        expect(media).toContain(`ai-jobs/${GUILD}/${campaignId}/`);

        expect(db.prepare('SELECT COUNT(*) c FROM entity_media').get()).toEqual({ c: 0 });
        expect(db.prepare('SELECT COUNT(*) c FROM reference_image').get()).toEqual({ c: 0 });
    });
});

describe('exportUserData', () => {
    it('returns what erasure would delete, and only for the asker', () => {
        seedGuild(GUILD, 'session-a');

        const exported = exportUserData(GUILD, USER);

        expect(exported.recordings).toHaveLength(1);
        expect((exported.recordings[0] as { transcription_text: string }).transcription_text)
            .toBe(`what ${USER} said`);
        expect(exported.characters).toHaveLength(1);
        expect(exported.sessionNotes).toHaveLength(1);
        expect(exported.chatHistory).toHaveLength(1);
        // Nothing belonging to the other player may appear in this file.
        expect(JSON.stringify(exported)).not.toContain(`what ${OTHER_USER} said`);
    });
});
