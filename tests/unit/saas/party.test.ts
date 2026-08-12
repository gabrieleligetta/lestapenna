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
import { db } from '../../../src/db';
import { WebSessionData } from '../../../src/api/auth/webSession.store';
import { signIn } from '../../fixtures/signIn';
import { SESSION_COOKIE_NAME } from '../../../src/api/auth/session.guard';

const GUILD = 'party-test-guild';

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

describe('GET /api/v1/campaigns/:id/party', () => {
    let app: NestFastifyApplication;
    let fastify: FastifyInstance;
    let sessionCookie: string;
    /** Has a faction flagged is_party. */
    let withFaction: number;
    /** Has none — the campaign columns are the fallback. */
    let withoutFaction: number;

    beforeAll(async () => {
        app = await createNestApp();
        await app.init();
        fastify = app.getHttpAdapter().getInstance();

        withFaction = campaignRepository.createCampaign(GUILD, 'Campaign With Party Faction');
        withoutFaction = campaignRepository.createCampaign(GUILD, 'Campaign Without Party Faction');

        // Three characters. Only two get an affiliation row: the third stands in
        // for the DM, who ensurePartyMembership never affiliates.
        characterRepository.updateUserCharacter('pc-1', withFaction, 'character_name', 'Aria');
        characterRepository.updateUserCharacter('pc-2', withFaction, 'character_name', 'Bram');
        characterRepository.updateUserCharacter('dm-1', withFaction, 'character_name', 'Zora');
        characterRepository.updateUserCharacter('pc-1', withFaction, 'description', 'A wandering bard.');

        const faction = factionRepository.createFaction(withFaction, 'The Ashen Hand', {
            description: 'The party itself',
            isParty: true,
        })!;
        const factionId = faction.id;
        db.prepare('UPDATE factions SET moral_score = ?, ethical_score = ? WHERE id = ?').run(60, -40, factionId);

        for (const [userId, role] of [
            ['pc-1', 'LEADER'],
            ['pc-2', 'MEMBER'],
        ] as const) {
            const rowid = characterRepository.getCharacterRowId(userId, withFaction)!;
            factionRepository.addAffiliation(factionId, 'pc', rowid, { role });
        }

        characterRepository.updateUserCharacter('pc-9', withoutFaction, 'character_name', 'Solo');
        db.prepare('UPDATE campaigns SET party_moral_score = ?, party_ethical_score = ? WHERE id = ?')
            .run(-80, 30, withoutFaction);

        sessionCookie = 'party-test-session';
        await signIn(sessionCookie, fakeSession());
    });

    afterAll(async () => {
        await app.close();
    });

    function get(url: string) {
        return fastify.inject({ method: 'GET', url, headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` } });
    }

    it('takes its name and alignment from the faction flagged is_party', async () => {
        const response = await get(`/api/v1/campaigns/${withFaction}/party`);
        expect(response.statusCode).toBe(200);

        const body = JSON.parse(response.payload);
        expect(body.name).toBe('The Ashen Hand');
        expect(body.alignmentSource).toBe('faction');
        expect(body.alignment).toMatchObject({
            moral: { score: 60, label: 'GOOD' },
            ethical: { score: -40, label: 'CHAOTIC' },
            cell: 'CHAOTIC_GOOD',
        });
    });

    it('falls back to the campaign columns when there is no party faction', async () => {
        const response = await get(`/api/v1/campaigns/${withoutFaction}/party`);

        const body = JSON.parse(response.payload);
        expect(body.name).toBe('Campaign Without Party Faction');
        expect(body.alignmentSource).toBe('campaign');
        expect(body.alignment).toMatchObject({
            moral: { score: -80, label: 'EVIL' },
            ethical: { score: 30, label: 'LAWFUL' },
        });
    });

    it('keeps a member who has no affiliation row — the DM would otherwise vanish', async () => {
        const response = await get(`/api/v1/campaigns/${withFaction}/party`);
        const body = JSON.parse(response.payload);

        const names = body.members.map((m: { name: string }) => m.name).sort();
        expect(names).toEqual(['Aria', 'Bram', 'Zora']);

        const zora = body.members.find((m: { name: string }) => m.name === 'Zora');
        expect(zora.role).toBeNull();
    });

    it('carries each member’s affiliation role and alignment', async () => {
        const response = await get(`/api/v1/campaigns/${withFaction}/party`);
        const body = JSON.parse(response.payload);

        const aria = body.members.find((m: { name: string }) => m.name === 'Aria');
        expect(aria.role).toBe('LEADER');
        expect(aria.alignment.moral).toHaveProperty('label');
        expect(aria.hasBio).toBe(true);

        const bram = body.members.find((m: { name: string }) => m.name === 'Bram');
        expect(bram.role).toBe('MEMBER');
        expect(bram.hasBio).toBe(false);
    });

    it('never ships the email column', async () => {
        const response = await get(`/api/v1/campaigns/${withFaction}/party`);
        expect(response.payload).not.toContain('email');
    });

    it('refuses a campaign in a guild the session is not a member of', async () => {
        const foreign = campaignRepository.createCampaign('some-other-guild', 'Not Mine');
        const response = await get(`/api/v1/campaigns/${foreign}/party`);
        expect(response.statusCode).toBe(403);
    });
});
