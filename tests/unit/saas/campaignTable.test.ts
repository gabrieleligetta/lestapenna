// No real Redis in the test environment — same in-memory fake as campaigns.test.ts.
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

const regenerateBioMock = jest.fn();
jest.mock('../../../src/bard', () => ({
    ...jest.requireActual('../../../src/bard'),
    resetAndRegenerateCharacterBio: (...args: unknown[]) => regenerateBioMock(...args),
}));

import { createNestApp } from '../../../src/api/main';
import { AiJobRunnerProvider } from '../../../src/api/aiJobs/aiJobRunner.provider';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyInstance } from 'fastify';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { campaignMemberRepository } from '../../../src/db/repositories/CampaignMemberRepository';
import { characterRepository } from '../../../src/db/repositories/CharacterRepository';
import { factionRepository } from '../../../src/db/repositories/FactionRepository';
import { getCampaignRole } from '../../../src/services/campaignAccess';
import { db } from '../../../src/db';
import { WebSessionData } from '../../../src/api/auth/webSession.store';
import { signIn } from '../../fixtures/signIn';
import { SESSION_COOKIE_NAME } from '../../../src/api/auth/session.guard';

const GUILD = 'table-guild';
const MASTER = 'user-table-master';
const PLAYER = 'user-table-player';
const OUTSIDER = 'user-table-outsider';

function fakeSession(userId: string, canManage = false): WebSessionData {
    return {
        discordUserId: userId,
        username: 'tester',
        globalName: null,
        avatar: null,
        accessToken: 'irrelevant',
        refreshToken: 'irrelevant',
        tokenExpiresAt: Date.now() + 999_999_999,
        guilds: [{ id: GUILD, name: 'Table Guild', icon: null, canManage }],
        guildsFetchedAt: Date.now(),
    };
}

/**
 * Campaign creation, table governance and the character sheet from the web.
 *
 * These were all Discord-only actions: what matters here is that the rules do not diverge
 * between the two interfaces — whoever creates is master, the last master cannot be
 * removed, and bio regeneration does not charge when there is no history to
 * rewrite from.
 */
describe('Tavolo e personaggi (web)', () => {
    let app: NestFastifyApplication;
    let fastify: FastifyInstance;
    let masterCookie: string;
    let playerCookie: string;
    let outsiderCookie: string;
    const createdCampaigns: number[] = [];

    beforeAll(async () => {
        app = await createNestApp();
        await app.init();
        fastify = app.getHttpAdapter().getInstance();

        masterCookie = 'table-master-session';
        await signIn(masterCookie, fakeSession(MASTER));
        playerCookie = 'table-player-session';
        await signIn(playerCookie, fakeSession(PLAYER));
        outsiderCookie = 'table-outsider-session';
        await signIn(outsiderCookie, fakeSession(OUTSIDER));
    });

    afterAll(async () => {
        await app.close();
        for (const id of createdCampaigns) {
            db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
        }
    });

    beforeEach(() => {
        regenerateBioMock.mockReset();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    function get(url: string, cookie = masterCookie) {
        return fastify.inject({ method: 'GET', url, headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });
    }

    function mutate(
        method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
        url: string,
        payload?: Record<string, unknown>,
        cookie = masterCookie,
    ) {
        return fastify.inject({
            method,
            url,
            headers: {
                cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
                ...(payload ? { 'content-type': 'application/json' } : {}),
            },
            ...(payload ? { payload: JSON.stringify(payload) } : {}),
        });
    }

    async function createCampaign(name: string, extra: Record<string, unknown> = {}, cookie = masterCookie) {
        const response = await mutate('POST', `/api/v1/guilds/${GUILD}/campaigns`, { name, ...extra }, cookie);
        if (response.statusCode === 201) createdCampaigns.push(JSON.parse(response.payload).id);
        return response;
    }

    describe('creazione campagna', () => {
        it('crea campagna, fazione party e iscrive chi crea come MASTER', async () => {
            const response = await createCampaign('La Corona Spezzata', {
                language: 'it',
                current_year: 1482,
                party_name: 'I Corvi Grigi',
            });

            expect(response.statusCode).toBe(201);
            const campaign = JSON.parse(response.payload);
            expect(campaign).toMatchObject({ name: 'La Corona Spezzata', currentYear: 1482, language: 'it' });

            expect(getCampaignRole(campaign.id, MASTER)).toBe('MASTER');
            expect(factionRepository.getPartyFaction(campaign.id)?.name).toBe('I Corvi Grigi');
        });

        it('rejects a duplicate name within the same guild', async () => {
            await createCampaign('Duplicata');
            const again = await createCampaign('  duplicata  ');
            expect(again.statusCode).toBe(409);
        });

        it('rejects an empty name and an unsupported language', async () => {
            expect((await createCampaign('   ')).statusCode).toBe(400);
            expect((await createCampaign('Lingua Ignota', { language: 'klingon' })).statusCode).toBe(400);
        });
    });

    describe('membri', () => {
        let campaignId: number;

        beforeEach(async () => {
            const response = await createCampaign(`Tavolo ${Math.random()}`);
            campaignId = JSON.parse(response.payload).id;
            campaignMemberRepository.upsert(campaignId, PLAYER, 'PLAYER');
        });

        it('lists the members with their character name where there is one', async () => {
            characterRepository.updateUserCharacter(PLAYER, campaignId, 'character_name', 'Thalia');

            const response = await get(`/api/v1/campaigns/${campaignId}/members`);
            expect(response.statusCode).toBe(200);
            const members = JSON.parse(response.payload);
            expect(members).toEqual(expect.arrayContaining([
                expect.objectContaining({ user_id: MASTER, role: 'MASTER', character_name: null }),
                expect.objectContaining({ user_id: PLAYER, role: 'PLAYER', character_name: 'Thalia' }),
            ]));
        });

        it('lists whoever has a character here, seat or no seat', async () => {
            // The seat register only ever got a row from `$iam` or campaign
            // creation: a table whose players joined earlier showed one member.
            characterRepository.updateUserCharacter(OUTSIDER, campaignId, 'character_name', 'Tommy');

            const response = await get(`/api/v1/campaigns/${campaignId}/members`);
            const members = JSON.parse(response.payload);

            expect(members).toEqual(expect.arrayContaining([
                expect.objectContaining({ user_id: MASTER, enrolled: true }),
                expect.objectContaining({ user_id: OUTSIDER, character_name: 'Tommy', enrolled: false }),
            ]));
            // No Discord connection in the tests: the names degrade to null
            // rather than failing the list.
            expect(members.every((m: { display_name: unknown }) => m.display_name === null)).toBe(true);
        });

        it('enrols a character owner who had no seat', async () => {
            characterRepository.updateUserCharacter(OUTSIDER, campaignId, 'character_name', 'Tommy');

            const enrolled = await mutate(
                'PATCH', `/api/v1/campaigns/${campaignId}/members/${OUTSIDER}`, { role: 'PLAYER' },
            );
            expect(enrolled.statusCode).toBe(204);
            expect(getCampaignRole(campaignId, OUTSIDER)).toBe('PLAYER');
        });

        it('only a master can promote or remove', async () => {
            const byPlayer = await mutate(
                'PATCH', `/api/v1/campaigns/${campaignId}/members/${MASTER}`, { role: 'PLAYER' }, playerCookie,
            );
            expect(byPlayer.statusCode).toBe(403);

            const promoted = await mutate(
                'PATCH', `/api/v1/campaigns/${campaignId}/members/${PLAYER}`, { role: 'MASTER' },
            );
            expect(promoted.statusCode).toBe(204);
            expect(getCampaignRole(campaignId, PLAYER)).toBe('MASTER');
        });

        it('never leaves the campaign without a master', async () => {
            const demoted = await mutate(
                'PATCH', `/api/v1/campaigns/${campaignId}/members/${MASTER}`, { role: 'PLAYER' },
            );
            const removed = await mutate('DELETE', `/api/v1/campaigns/${campaignId}/members/${MASTER}`);

            expect(demoted.statusCode).toBe(409);
            expect(removed.statusCode).toBe(409);
            expect(getCampaignRole(campaignId, MASTER)).toBe('MASTER');
        });

        it('removes a player without deleting their character', async () => {
            characterRepository.updateUserCharacter(PLAYER, campaignId, 'character_name', 'Thalia');

            const removed = await mutate('DELETE', `/api/v1/campaigns/${campaignId}/members/${PLAYER}`);
            expect(removed.statusCode).toBe(204);
            expect(getCampaignRole(campaignId, PLAYER)).toBeNull();
            expect(characterRepository.getUserName(PLAYER, campaignId)).toBe('Thalia');
        });

        it('404 for a user who is not at the table', async () => {
            const response = await mutate(
                'PATCH', `/api/v1/campaigns/${campaignId}/members/${OUTSIDER}`, { role: 'MASTER' },
            );
            expect(response.statusCode).toBe(404);
        });
    });

    describe('impostazioni campagna', () => {
        let campaignId: number;

        beforeEach(async () => {
            const response = await createCampaign(`Mondo ${Math.random()}`, { party_name: 'Vecchio Nome' });
            campaignId = JSON.parse(response.payload).id;
            campaignMemberRepository.upsert(campaignId, PLAYER, 'PLAYER');
        });

        it('updates name, language, year and party name', async () => {
            const response = await mutate('PATCH', `/api/v1/campaigns/${campaignId}/settings`, {
                name: 'Le Ceneri di Neverwinter',
                language: 'en',
                current_year: 1499,
                party_name: 'I Senza Nome',
                allow_auto_character_update: true,
            });

            expect(response.statusCode).toBe(200);
            expect(JSON.parse(response.payload)).toMatchObject({
                name: 'Le Ceneri di Neverwinter',
                language: 'en',
                current_year: 1499,
                party_name: 'I Senza Nome',
                allow_auto_character_update: true,
            });
            expect(factionRepository.getPartyFaction(campaignId)?.name).toBe('I Senza Nome');
        });

        it('a player can read the settings but not change them', async () => {
            expect((await get(`/api/v1/campaigns/${campaignId}/settings`, playerCookie)).statusCode).toBe(200);
            const write = await mutate(
                'PATCH', `/api/v1/campaigns/${campaignId}/settings`, { current_year: 1500 }, playerCookie,
            );
            expect(write.statusCode).toBe(403);
        });

        it('rejects an unsupported language and a name already taken', async () => {
            const other = await createCampaign('Nome Occupato');
            const clash = await mutate(
                'PATCH', `/api/v1/campaigns/${campaignId}/settings`, { name: 'Nome Occupato' },
            );
            const badLanguage = await mutate(
                'PATCH', `/api/v1/campaigns/${campaignId}/settings`, { language: 'klingon' },
            );

            expect(other.statusCode).toBe(201);
            expect(clash.statusCode).toBe(409);
            expect(badLanguage.statusCode).toBe(400);
        });
    });

    describe('scheda personaggio', () => {
        let campaignId: number;

        beforeEach(async () => {
            const response = await createCampaign(`PG ${Math.random()}`);
            campaignId = JSON.parse(response.payload).id;
        });

        it('crea la propria scheda e iscrive chi la compila al tavolo', async () => {
            const response = await mutate('PUT', `/api/v1/campaigns/${campaignId}/characters/me`, {
                character_name: 'Kaelen',
                race: 'Mezzelfo',
                class: 'Ladro',
            }, outsiderCookie);

            expect(response.statusCode).toBe(200);
            expect(JSON.parse(response.payload)).toMatchObject({
                user_id: OUTSIDER, character_name: 'Kaelen', race: 'Mezzelfo', class: 'Ladro',
            });
            // Filling in the sheet is the gesture of sitting down at the table.
            expect(getCampaignRole(campaignId, OUTSIDER)).toBe('PLAYER');
        });

        it('a hand-written biography marks the record as manual', async () => {
            await mutate('PUT', `/api/v1/campaigns/${campaignId}/characters/me`, {
                character_name: 'Kaelen', description: 'Cresciuto fra i moli di Luskan.',
            }, outsiderCookie);

            const sheet = JSON.parse(
                (await get(`/api/v1/campaigns/${campaignId}/characters/${OUTSIDER}/sheet`)).payload,
            );
            expect(sheet.is_manual).toBe(true);
            const row = db.prepare('SELECT manual_description FROM characters WHERE campaign_id = ? AND user_id = ?')
                .get(campaignId, OUTSIDER) as { manual_description: string };
            expect(row.manual_description).toBe('Cresciuto fra i moli di Luskan.');
        });

        it('un giocatore non modifica la scheda di un altro, un master sì', async () => {
            campaignMemberRepository.upsert(campaignId, PLAYER, 'PLAYER');
            await mutate('PUT', `/api/v1/campaigns/${campaignId}/characters/me`, {
                character_name: 'Kaelen',
            }, outsiderCookie);

            const byPlayer = await mutate(
                'PATCH', `/api/v1/campaigns/${campaignId}/characters/${OUTSIDER}/sheet`, { class: 'Bardo' }, playerCookie,
            );
            const byMaster = await mutate(
                'PATCH', `/api/v1/campaigns/${campaignId}/characters/${OUTSIDER}/sheet`, { class: 'Bardo' },
            );

            expect(byPlayer.statusCode).toBe(403);
            expect(byMaster.statusCode).toBe(200);
            expect(JSON.parse(byMaster.payload).class).toBe('Bardo');
        });

        it('does not invoke the AI for the bio when there is no history to rewrite', async () => {
            await mutate('PUT', `/api/v1/campaigns/${campaignId}/characters/me`, { character_name: 'Kaelen' }, masterCookie);

            const estimate = JSON.parse(
                (await get(`/api/v1/campaigns/${campaignId}/characters/${MASTER}/bio/estimate`)).payload,
            );
            const response = await mutate('POST', `/api/v1/campaigns/${campaignId}/characters/${MASTER}/bio`);

            expect(estimate).toMatchObject({ status: 'NO_HISTORY', will_invoke_ai: false });
            expect(response.statusCode).toBe(202);
            // No history, no job, nothing spent: the free path stays free.
            expect(JSON.parse(response.payload)).toMatchObject({ invoked_ai: false, job_id: null });
            expect(regenerateBioMock).not.toHaveBeenCalled();
        });

        it('reports the real cost when the biography is actually regenerated', async () => {
            await mutate('PUT', `/api/v1/campaigns/${campaignId}/characters/me`, { character_name: 'Kaelen' }, masterCookie);
            characterRepository.addCharacterEvent(campaignId, 'Kaelen', 'sess-1', 'Ha tradito la gilda.', 'ACHIEVEMENT');
            regenerateBioMock.mockImplementation(async (_c: number, _u: string, onCost?: (c: unknown) => void) => {
                onCost?.({ costUsd: 0.004, costEur: 0.0036 });
                return 'Una nuova biografia.';
            });

            const estimate = JSON.parse(
                (await get(`/api/v1/campaigns/${campaignId}/characters/${MASTER}/bio/estimate`)).payload,
            );
            const response = await mutate('POST', `/api/v1/campaigns/${campaignId}/characters/${MASTER}/bio`);

            expect(estimate).toMatchObject({ status: 'READY', will_invoke_ai: true });
            expect(response.statusCode).toBe(202);
            const { job_id: jobId } = JSON.parse(response.payload);
            await app.get(AiJobRunnerProvider).instance.waitForIdle();

            const job = JSON.parse((await get(
                `/api/v1/campaigns/${campaignId}/ai-jobs/${jobId}`,
            )).payload);
            expect(job.status).toBe('succeeded');
            // The declared cost is the one really incurred on the provider account.
            expect(job.cost_usd).toBeCloseTo(0.004);
        });

        it('refuses a second rewrite of the same biography while one is running', async () => {
            await mutate('PUT', `/api/v1/campaigns/${campaignId}/characters/me`, { character_name: 'Kaelen' }, masterCookie);
            characterRepository.addCharacterEvent(campaignId, 'Kaelen', 'sess-1', 'Ha tradito la gilda.', 'ACHIEVEMENT');
            let release: (value: unknown) => void = () => {};
            regenerateBioMock.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

            const first = await mutate('POST', `/api/v1/campaigns/${campaignId}/characters/${MASTER}/bio`);
            expect(first.statusCode).toBe(202);
            // This route had no lock at all before the register: a double click
            // was two paid rewrites of the same biography.
            const second = await mutate('POST', `/api/v1/campaigns/${campaignId}/characters/${MASTER}/bio`);
            expect(second.statusCode).toBe(409);

            release('Una nuova biografia.');
            await app.get(AiJobRunnerProvider).instance.waitForIdle();
            expect(regenerateBioMock).toHaveBeenCalledTimes(1);
        });

        it('records a failed rewrite instead of losing it', async () => {
            await mutate('PUT', `/api/v1/campaigns/${campaignId}/characters/me`, { character_name: 'Kaelen' }, masterCookie);
            characterRepository.addCharacterEvent(campaignId, 'Kaelen', 'sess-1', 'Ha tradito la gilda.', 'ACHIEVEMENT');
            regenerateBioMock.mockRejectedValue(new Error('provider down'));

            const response = await mutate('POST', `/api/v1/campaigns/${campaignId}/characters/${MASTER}/bio`);
            expect(response.statusCode).toBe(202);
            await app.get(AiJobRunnerProvider).instance.waitForIdle();

            const job = JSON.parse((await get(
                `/api/v1/campaigns/${campaignId}/ai-jobs/${JSON.parse(response.payload).job_id}`,
            )).payload);
            // The failure is a record a person can read later, not a status code
            // that vanished with the request that received it.
            expect(job.status).toBe('failed');
            expect(job.error_message).toContain('provider down');
        });
    });
});
