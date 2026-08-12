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
import { characterRepository } from '../../../src/db/repositories/CharacterRepository';
import { factionRepository } from '../../../src/db/repositories/FactionRepository';
import { npcRepository } from '../../../src/db/repositories/NpcRepository';
import { db } from '../../../src/db';
import { WebSessionData } from '../../../src/api/auth/webSession.store';
import { signIn } from '../../fixtures/signIn';
import { SESSION_COOKIE_NAME } from '../../../src/api/auth/session.guard';

const GUILD = 'factions-test-guild';

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

describe('Faction endpoints', () => {
    let app: NestFastifyApplication;
    let fastify: FastifyInstance;
    let campaignId: number;
    let cabalShortId: string;
    let quietShortId: string;
    let sessionCookie: string;

    beforeAll(async () => {
        app = await createNestApp();
        await app.init();
        fastify = app.getHttpAdapter().getInstance();

        campaignId = campaignRepository.createCampaign(GUILD, 'Faction Campaign');

        const cabal = factionRepository.createFaction(campaignId, 'The Ashen Circle', { description: 'A cabal' })!;
        cabalShortId = cabal.short_id!;
        factionRepository.setFactionReputation(campaignId, cabal.id, 'FRIENDLY');
        db.prepare('UPDATE factions SET moral_score = ?, ethical_score = ? WHERE id = ?').run(-70, 55, cabal.id);

        // Never given a reputation row: the default has to be NEUTRAL, not null.
        const quiet = factionRepository.createFaction(campaignId, 'The Quiet Ones', {})!;
        quietShortId = quiet.short_id!;

        npcRepository.updateNpcEntry(campaignId, 'Helena', 'An innkeeper', undefined, undefined, 'session-1');
        const npc = npcRepository.getNpcEntry(campaignId, 'Helena')!;
        factionRepository.addAffiliation(cabal.id, 'npc', npc.id, { role: 'LEADER' });

        characterRepository.updateUserCharacter('pc-1', campaignId, 'character_name', 'Aria');
        const rowid = characterRepository.getCharacterRowId('pc-1', campaignId)!;
        factionRepository.addAffiliation(cabal.id, 'pc', rowid, { role: 'ALLY' });

        // Inactive: must not appear in the member list.
        characterRepository.updateUserCharacter('pc-2', campaignId, 'character_name', 'Bram');
        const bramRowid = characterRepository.getCharacterRowId('pc-2', campaignId)!;
        factionRepository.addAffiliation(cabal.id, 'pc', bramRowid, { role: 'MEMBER' });
        db.prepare('UPDATE faction_affiliations SET is_active = 0 WHERE faction_id = ? AND entity_id = ?')
            .run(cabal.id, bramRowid);

        sessionCookie = 'factions-test-session';
        await signIn(sessionCookie, fakeSession());
    });

    afterAll(async () => {
        await app.close();
    });

    function get(url: string) {
        return fastify.inject({ method: 'GET', url, headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` } });
    }

    it('carries reputation on the list, defaulting to NEUTRAL', async () => {
        const response = await get(`/api/v1/campaigns/${campaignId}/factions`);
        expect(response.statusCode).toBe(200);

        const body = JSON.parse(response.payload);
        const byName = Object.fromEntries(body.items.map((f: { name: string }) => [f.name, f]));
        expect(byName['The Ashen Circle'].reputation).toBe('FRIENDLY');
        expect(byName['The Quiet Ones'].reputation).toBe('NEUTRAL');
    });

    it('returns detail with computed alignment labels and member counts', async () => {
        const response = await get(`/api/v1/campaigns/${campaignId}/factions/${cabalShortId}`);

        const body = JSON.parse(response.payload);
        expect(body.alignment).toMatchObject({
            moral: { score: -70, label: 'EVIL' },
            ethical: { score: 55, label: 'LAWFUL' },
            cell: 'LAWFUL_EVIL',
        });
        expect(body.reputation).toBe('FRIENDLY');
        expect(body.memberCounts).toMatchObject({ npcs: 1 });
    });

    it('never exposes the breakdown object, whose member figures are hardcoded zeros', async () => {
        const response = await get(`/api/v1/campaigns/${campaignId}/factions/${cabalShortId}`);
        expect(response.payload).not.toContain('breakdown');
        expect(response.payload).not.toContain('membersMoral');
    });

    it('resolves a PC member to their character name, not "ID:7"', async () => {
        // getFactionMembers, which the $faction embed uses, has no 'pc' branch in
        // its CASE and renders the literal 'ID:' || entity_id.
        const response = await get(`/api/v1/campaigns/${campaignId}/factions/${cabalShortId}/members`);
        expect(response.statusCode).toBe(200);

        const body = JSON.parse(response.payload);
        const pc = body.items.find((m: { entityType: string }) => m.entityType === 'pc');
        expect(pc.name).toBe('Aria');
        expect(pc.userId).toBe('pc-1');
        expect(response.payload).not.toContain('ID:');
    });

    it('gives NPC and location members a short_id so the client can link to them', async () => {
        const response = await get(`/api/v1/campaigns/${campaignId}/factions/${cabalShortId}/members`);

        const body = JSON.parse(response.payload);
        const npc = body.items.find((m: { entityType: string }) => m.entityType === 'npc');
        expect(npc.name).toBe('Helena');
        expect(npc.shortId).toMatch(/^\w{5}$/);
        expect(npc.role).toBe('LEADER');
    });

    it('excludes inactive affiliations', async () => {
        const response = await get(`/api/v1/campaigns/${campaignId}/factions/${cabalShortId}/members`);

        const body = JSON.parse(response.payload);
        expect(body.items.map((m: { name: string }) => m.name)).not.toContain('Bram');
    });

    it('404s an unknown faction short_id', async () => {
        const response = await get(`/api/v1/campaigns/${campaignId}/factions/zzzzz/members`);
        expect(response.statusCode).toBe(404);
        // The unrelated faction still resolves, so this is not a broken route.
        expect((await get(`/api/v1/campaigns/${campaignId}/factions/${quietShortId}`)).statusCode).toBe(200);
    });
});
