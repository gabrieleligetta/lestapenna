// No real Redis in the test environment — same in-memory fake as auth.test.ts.
jest.mock('ioredis', () => {
    const store = new Map<string, string>();
    return jest.fn().mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        get: jest.fn(async (key: string) => store.get(key) ?? null),
        set: jest.fn(async (key: string, value: string) => {
            store.set(key, value);
            return 'OK';
        }),
        del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
        ttl: jest.fn(async (key: string) => (store.has(key) ? 3600 : -2)),
    }));
});

// Object storage is mocked: this is about which rows the endpoints reach.
jest.mock('../../../src/services/backup', () => ({
    deleteByPrefix: jest.fn(async () => 0),
}));

import { createNestApp } from '../../../src/api/main';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyInstance } from 'fastify';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { characterRepository } from '../../../src/db/repositories/CharacterRepository';
import { db } from '../../../src/db';
import { WebSessionData } from '../../../src/api/auth/webSession.store';
import { createWebSession } from '../../../src/api/auth/webSession.store';
import { signIn } from '../../fixtures/signIn';
import { SESSION_COOKIE_NAME } from '../../../src/api/auth/session.guard';

const GUILD = 'mydata-test-guild';
const OTHER_GUILD = 'mydata-other-guild';
const ME = 'user-me';
const MATE = 'user-mate';

function fakeSession(userId: string, guilds = [GUILD]): WebSessionData {
    return {
        discordUserId: userId,
        username: 'tester',
        globalName: null,
        avatar: null,
        accessToken: 'irrelevant',
        refreshToken: 'irrelevant',
        tokenExpiresAt: Date.now() + 999_999_999,
        guilds: guilds.map(id => ({ id, name: 'My Table', icon: null, canManage: true })),
        guildsFetchedAt: Date.now(),
    };
}

/**
 * The web counterpart of `$mydata` and `$forgetme`.
 *
 * Discord's Developer Terms §5(b) require an «easily accessible way» to have
 * one's data modified and deleted; GDPR art. 15 and 20 add the copy. Existing
 * only as a Discord command made it accessible to the half of a table that uses
 * Discord and to nobody else.
 */
describe('/api/v1/me/guilds/:guildId — my data', () => {
    let app: NestFastifyApplication;
    let fastify: FastifyInstance;
    let myCookie: string;
    let campaignId: number;

    beforeAll(async () => {
        app = await createNestApp();
        await app.init();
        fastify = app.getHttpAdapter().getInstance();

        campaignId = campaignRepository.createCampaign(GUILD, 'The Campaign');
        db.prepare('INSERT INTO sessions (session_id, session_number, guild_id, campaign_id) VALUES (?, 1, ?, ?)')
            .run('session-1', GUILD, campaignId);

        for (const userId of [ME, MATE]) {
            characterRepository.updateUserCharacter(userId, campaignId, 'character_name', `PC of ${userId}`);
            db.prepare(
                `INSERT INTO recordings (session_id, filename, filepath, user_id, timestamp, status, transcription_text)
                 VALUES (?, ?, ?, ?, ?, 'PROCESSED', ?)`,
            ).run('session-1', `${userId}.flac`, `/tmp/${userId}.flac`, userId, Date.now(), `what ${userId} said`);
        }

        myCookie = 'mydata-session';
        await signIn(myCookie, fakeSession(ME));
    });

    afterAll(async () => {
        await app.close();
    });

    function headers(cookie: string) {
        return { cookie: `${SESSION_COOKIE_NAME}=${cookie}` };
    }

    it('exports the caller’s own data and nobody else’s', async () => {
        const response = await fastify.inject({
            method: 'GET',
            url: `/api/v1/me/guilds/${GUILD}/export`,
            headers: headers(myCookie),
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        expect(body.recordings).toHaveLength(1);
        expect(body.recordings[0].transcription_text).toBe(`what ${ME} said`);
        expect(response.payload).not.toContain(`what ${MATE} said`);
    });

    it('refuses a guild the caller is not a member of', async () => {
        const response = await fastify.inject({
            method: 'GET',
            url: `/api/v1/me/guilds/${OTHER_GUILD}/export`,
            headers: headers(myCookie),
        });

        expect(response.statusCode).toBe(403);
    });

    it('works even for someone who has not accepted the documents', async () => {
        // Deliberately not through `signIn`: taking your data and leaving must
        // not be conditional on agreeing to anything first.
        const unacceptedCookie = 'mydata-unaccepted-session';
        await createWebSession(unacceptedCookie, fakeSession('user-refuser'));

        const response = await fastify.inject({
            method: 'GET',
            url: `/api/v1/me/guilds/${GUILD}/export`,
            headers: headers(unacceptedCookie),
        });

        expect(response.statusCode).toBe(200);
    });

    it('erases the caller’s data and leaves the table’s standing', async () => {
        const response = await fastify.inject({
            method: 'DELETE',
            url: `/api/v1/me/guilds/${GUILD}/data`,
            headers: headers(myCookie),
        });

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload).complete).toBe(true);

        const mine = db.prepare('SELECT COUNT(*) c FROM recordings WHERE user_id = ?').get(ME);
        const theirs = db.prepare('SELECT COUNT(*) c FROM recordings WHERE user_id = ?').get(MATE);
        expect(mine).toEqual({ c: 0 });
        expect(theirs).toEqual({ c: 1 });

        // The campaign is the whole table's: one member's request must not take it.
        expect(db.prepare('SELECT COUNT(*) c FROM campaigns WHERE id = ?').get(campaignId)).toEqual({ c: 1 });
    });
});
