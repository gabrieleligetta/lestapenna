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

import { createNestApp } from '../../../src/api/main';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyInstance } from 'fastify';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { npcRepository } from '../../../src/db/repositories/NpcRepository';
import { locationRepository } from '../../../src/db/repositories/LocationRepository';
import { WebSessionData } from '../../../src/api/auth/webSession.store';
import { signIn } from '../../fixtures/signIn';
import { SESSION_COOKIE_NAME } from '../../../src/api/auth/session.guard';

const GUILD = 'events-test-guild';

function fakeSession(): WebSessionData {
    return {
        discordUserId: 'user-1',
        username: 'tester',
        globalName: null,
        avatar: null,
        accessToken: 'irrelevant',
        refreshToken: 'irrelevant',
        tokenExpiresAt: Date.now() + 999_999_999,
        guilds: [{ id: GUILD, name: 'My Table', icon: null, canManage: true }],
        guildsFetchedAt: Date.now(),
    };
}

/** Fixed timestamps so "newest first" is an assertion, not a race. */
const T = { oldest: 1_000, middle: 2_000, newest: 3_000 };

describe('Entity history endpoints', () => {
    let app: NestFastifyApplication;
    let fastify: FastifyInstance;
    let campaignId: number;
    let npcShortId: string;
    let locationShortId: string;
    let sessionCookie: string;

    beforeAll(async () => {
        app = await createNestApp();
        await app.init();
        fastify = app.getHttpAdapter().getInstance();

        campaignId = campaignRepository.createCampaign(GUILD, 'Events Campaign');

        npcRepository.updateNpcEntry(campaignId, 'Helena', 'An innkeeper', undefined, undefined, 'session-1');
        npcRepository.addNpcEvent(campaignId, 'Helena', 'session-1', 'Met the party', 'REVELATION', false, T.middle);
        npcRepository.addNpcEvent(campaignId, 'Helena', 'session-2', 'Betrayed them', 'BETRAYAL', false, T.newest);
        npcRepository.addNpcEvent(campaignId, 'Helena', 'session-0', 'Was born', 'STATUS_CHANGE', false, T.oldest);
        npcShortId = npcRepository.getNpcEntry(campaignId, 'Helena')!.short_id!;

        locationRepository.updateAtlasEntry(campaignId, 'Neverwinter', 'The Docks', 'A busy port', 'session-1');
        locationRepository.addAtlasEvent(campaignId, 'Neverwinter', 'The Docks', 'session-1', 'A ship burned', 'GENERIC', false, T.middle);
        locationRepository.addAtlasEvent(campaignId, 'Neverwinter', 'The Docks', 'session-2', 'The docks reopened', 'GENERIC', false, T.newest);
        locationShortId = locationRepository.getAtlasEntryFull(campaignId, 'Neverwinter', 'The Docks')!.short_id!;

        sessionCookie = 'events-test-session';
        await signIn(sessionCookie, fakeSession());
    });

    afterAll(async () => {
        await app.close();
    });

    function get(url: string) {
        return fastify.inject({ method: 'GET', url, headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` } });
    }

    it('returns the newest event first', async () => {
        // The repository getters default to `timestamp ASC` because RAG summaries
        // and alignment rebuilds read chronologically. Page one of the web view
        // used to show the oldest events in an NPC's life.
        const response = await get(`/api/v1/campaigns/${campaignId}/npcs/${npcShortId}/events`);
        expect(response.statusCode).toBe(200);

        const body = JSON.parse(response.payload);
        expect(body.items.map((e: { description: string }) => e.description)).toEqual([
            'Betrayed them',
            'Met the party',
            'Was born',
        ]);
    });

    it('wraps events in the page envelope with a real total', async () => {
        const response = await get(`/api/v1/campaigns/${campaignId}/npcs/${npcShortId}/events?limit=2`);

        const body = JSON.parse(response.payload);
        expect(body.total).toBe(3);
        expect(body.limit).toBe(2);
        expect(body.items).toHaveLength(2);
    });

    it('pages without repeating or dropping an event', async () => {
        const first = JSON.parse((await get(`/api/v1/campaigns/${campaignId}/npcs/${npcShortId}/events?limit=2`)).payload);
        const second = JSON.parse(
            (await get(`/api/v1/campaigns/${campaignId}/npcs/${npcShortId}/events?limit=2&offset=2`)).payload,
        );

        expect(second.items).toHaveLength(1);
        expect(second.items[0].description).toBe('Was born');
        const ids = [...first.items, ...second.items].map((e: { id: number }) => e.id);
        expect(new Set(ids).size).toBe(3);
    });

    it('gives location events an id and a timestamp', async () => {
        // getAtlasHistory selected only description/event_type/session_id while
        // every other history getter returns the full row: the web had no stable
        // React key and printed every location event's date as "—".
        const response = await get(`/api/v1/campaigns/${campaignId}/locations/${locationShortId}/events`);

        const body = JSON.parse(response.payload);
        expect(body.items).toHaveLength(2);
        for (const event of body.items) {
            expect(typeof event.id).toBe('number');
            expect(event.id).toBeGreaterThan(0);
            expect(typeof event.timestamp).toBe('number');
        }
        expect(body.items[0].description).toBe('The docks reopened');
    });
});
