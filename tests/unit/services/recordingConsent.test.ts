/**
 * Recording evidence and the register of acceptances.
 *
 * The people being recorded are the players in the voice channel, and almost none of
 * them will ever open the web app. The safeguard that counts for them is on Discord —
 * the marked nickname and the in-channel notice — not a box ticked by
 * whoever logs in.
 */

import { wipeDatabase } from '../../../src/db/maintenance';
import { db } from '../../../src/db';
import {
    LEGAL_VERSIONS,
    legalStatusFor,
    needsLegalAcceptance,
    recordLegalAcceptance,
} from '../../../src/services/legalAcceptance';
import { announceRecording, clearRecording, markRecording } from '../../../src/services/recordingNotice';

const USER = 'user-legale';
const GUILD = 'gilda-avviso';

beforeEach(() => wipeDatabase());

/** A fake guild with just enough for the marker. */
function fakeGuild(options: { canRename?: boolean; nickname?: string | null } = {}) {
    const { canRename = true, nickname = null } = options;
    const setNickname = jest.fn(async (value: string | null) => {
        if (!canRename) throw new Error('Missing Permissions');
        guild.members.me.nickname = value;
    });
    const guild: any = {
        id: GUILD,
        members: { me: { nickname, user: { username: 'Lestapenna' }, setNickname } },
        client: { user: { setActivity: jest.fn() } },
    };
    return guild;
}

describe('making the recording evident', () => {
    it('marks the nickname, so it shows in the user list', async () => {
        const guild = fakeGuild();
        const ok = await markRecording(guild, { name: 'Taverna' } as any);

        expect(ok).toBe(true);
        expect(guild.members.me.nickname).toBe('[REC] Lestapenna');
    });

    it('does NOT record when it cannot display the marker', async () => {
        // It is the choice made by Craig, the most widely used recording bot in this
        // niche, and it is the right one: an indicator that can be switched off is not an
        // indicator. Better not to start than to record covertly.
        const guild = fakeGuild({ canRename: false });
        expect(await markRecording(guild, { name: 'Taverna' } as any)).toBe(false);
    });

    it('does not stack prefixes when the marker is already there', async () => {
        // A session started twice must not produce `[REC] [REC] …`,
        // which besides being ugly saturates Discord's 32 characters.
        const guild = fakeGuild({ nickname: '[REC] Lestapenna' });
        await markRecording(guild, { name: 'Taverna' } as any);
        expect(guild.members.me.nickname).toBe('[REC] Lestapenna');
    });

    it('removes it when the session ends', async () => {
        const guild = fakeGuild({ nickname: '[REC] Bardo' });
        await clearRecording(guild);
        expect(guild.members.me.nickname).toBe('Bardo');
    });

    it('does not leave the bot marked if the cleanup fails', async () => {
        // It must never fail the caller: the session has ended regardless.
        const guild = fakeGuild({ canRename: false, nickname: '[REC] Bardo' });
        await expect(clearRecording(guild)).resolves.toBeUndefined();
    });
});

describe('avviso in canale', () => {
    function fakeChannel() {
        return { send: jest.fn().mockResolvedValue(undefined) } as any;
    }

    it('gives it in full the first time', async () => {
        const channel = fakeChannel();
        await announceRecording(fakeGuild(), channel, { name: 'Taverna' } as any, 'it');

        const sent = channel.send.mock.calls[0][0] as string;
        // It has to say what happens to the audio and how to opt out: a notice
        // that only says «I am recording» is no help in deciding.
        expect(sent).toMatch(/esci dal canale/i);
        expect(sent).toMatch(/privacy/i);
        expect(sent).toContain('Taverna');
    });

    it('shortens it from the second time on', async () => {
        // The long version repeated at every session becomes noise nobody
        // reads, which is worse than a short notice that is read.
        const guild = fakeGuild();
        const first = fakeChannel();
        await announceRecording(guild, first, { name: 'Taverna' } as any, 'it');

        const second = fakeChannel();
        await announceRecording(guild, second, { name: 'Taverna' } as any, 'it');

        expect((second.send.mock.calls[0][0] as string).length)
            .toBeLessThan((first.send.mock.calls[0][0] as string).length);
    });

    it('does not record a notice it failed to send as given', async () => {
        const guild = fakeGuild();
        const channel = { send: jest.fn().mockRejectedValue(new Error('no perms')) } as any;
        await announceRecording(guild, channel, { name: 'Taverna' } as any, 'it');

        const row = db.prepare('SELECT recording_notice_at FROM tenants WHERE guild_id = ?').get(GUILD);
        expect(row).toBeUndefined();
    });
});

describe('the record of acceptances', () => {
    it('a new user has to accept', () => {
        expect(needsLegalAcceptance(USER)).toBe(true);
        expect(legalStatusFor(USER).every(s => s.needsAcceptance)).toBe(true);
    });

    it('stops asking once accepted', () => {
        recordLegalAcceptance(USER, ['terms', 'privacy']);
        expect(needsLegalAcceptance(USER)).toBe(false);
    });

    it('asks again when the document changes', () => {
        recordLegalAcceptance(USER, ['terms', 'privacy']);
        db.prepare("UPDATE legal_acceptances SET version = '2020-01-01' WHERE document = 'terms'").run();

        const terms = legalStatusFor(USER).find(s => s.document === 'terms')!;
        expect(terms.needsAcceptance).toBe(true);
        // The notice has not changed: it is not shown again by association.
        expect(legalStatusFor(USER).find(s => s.document === 'privacy')!.needsAcceptance).toBe(false);
    });

    it('is append-only: the old row stays', () => {
        // It exists so we can say WHAT was accepted and WHEN. An overwritten
        // row would no longer say that.
        recordLegalAcceptance(USER, ['terms']);
        recordLegalAcceptance(USER, ['terms']);

        const count = db.prepare(
            'SELECT COUNT(*) AS n FROM legal_acceptances WHERE discord_user_id = ? AND document = ?',
        ).get(USER, 'terms') as { n: number };
        expect(count.n).toBe(2);
    });

    it('records the version the server decided, not the one claimed', () => {
        // Otherwise one could declare having accepted a text never
        // seen, and the register would be worth about as much as a sticky note.
        recordLegalAcceptance(USER, ['terms']);
        const row = db.prepare(
            'SELECT version FROM legal_acceptances WHERE discord_user_id = ?',
        ).get(USER) as { version: string };
        expect(row.version).toBe(LEGAL_VERSIONS.terms);
    });

    it('does not keep the IP address', () => {
        // It would be one more personal datum collected to strengthen evidence
        // that the timestamp and the Discord identity already give.
        const columns = db.prepare('PRAGMA table_info(legal_acceptances)').all() as Array<{ name: string }>;
        expect(columns.map(c => c.name)).not.toContain('ip');
    });
});
