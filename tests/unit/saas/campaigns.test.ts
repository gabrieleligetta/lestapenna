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

const mockCloudObjectExists = jest.fn().mockResolvedValue(false);
const mockGetPresignedUrl = jest.fn().mockResolvedValue(null);

jest.mock('../../../src/services/backup', () => ({
    ...jest.requireActual('../../../src/services/backup'),
    cloudObjectExists: mockCloudObjectExists,
    getPresignedUrl: mockGetPresignedUrl,
}));

const mockGetUsdEurRate = jest.fn().mockResolvedValue({
    source: 'ECB',
    usdPerEur: 1.1,
    rateDate: '2026-07-27',
    fetchedAt: 1_775_000_000_000,
});

jest.mock('../../../src/services/aiCostTransparency', () => ({
    ...jest.requireActual('../../../src/services/aiCostTransparency'),
    getUsdEurRate: mockGetUsdEurRate,
}));

const mockRunHistoricalQuestAuditAgent = jest.fn();

jest.mock('../../../src/bard/agent/questLifecycle', () => ({
    ...jest.requireActual('../../../src/bard/agent/questLifecycle'),
    runHistoricalQuestAuditAgent: mockRunHistoricalQuestAuditAgent,
}));

import { createNestApp } from '../../../src/api/main';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyInstance } from 'fastify';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { npcRepository } from '../../../src/db/repositories/NpcRepository';
import { characterRepository } from '../../../src/db/repositories/CharacterRepository';
import { locationRepository } from '../../../src/db/repositories/LocationRepository';
import { factionRepository } from '../../../src/db/repositories/FactionRepository';
import { questRepository } from '../../../src/db/repositories/QuestRepository';
import { inventoryRepository } from '../../../src/db/repositories/InventoryRepository';
import { artifactRepository } from '../../../src/db/repositories/ArtifactRepository';
import { bestiaryRepository } from '../../../src/db/repositories/BestiaryRepository';
import { worldRepository } from '../../../src/db/repositories/WorldRepository';
import { sessionRepository } from '../../../src/db/repositories/SessionRepository';
import { db } from '../../../src/db';
import { WebSessionData } from '../../../src/api/auth/webSession.store';
import { signIn } from '../../fixtures/signIn';
import { SESSION_COOKIE_NAME } from '../../../src/api/auth/session.guard';
import { AiJobRunnerProvider } from '../../../src/api/aiJobs/aiJobRunner.provider';

const MEMBER_GUILD = 'test-guild-with-access';
const OTHER_GUILD = 'test-guild-without-access';

function fakeSession(guilds: WebSessionData['guilds']): WebSessionData {
    return {
        discordUserId: 'user-1',
        username: 'tester',
        globalName: null,
        avatar: null,
        accessToken: 'irrelevant',
        refreshToken: 'irrelevant',
        tokenExpiresAt: Date.now() + 999_999_999,
        guilds,
        guildsFetchedAt: Date.now(), // fresh: ensureGuilds won't try to refetch from Discord
    };
}

describe('Guilds + Campaigns read endpoints (Fase 2.3/2.4)', () => {
    let app: NestFastifyApplication;
    let fastify: FastifyInstance;
    let campaignId: number;
    let sessionCookie: string;
    let readOnlySessionCookie: string;

    beforeAll(async () => {
        app = await createNestApp();
        await app.init();
        fastify = app.getHttpAdapter().getInstance();

        campaignId = campaignRepository.createCampaign(MEMBER_GUILD, 'Test Campaign');
        campaignRepository.setCampaignYear(campaignId, 1250);
        characterRepository.updateUserCharacter('pc-1', campaignId, 'character_name', 'Aria');
        npcRepository.updateNpcEntry(campaignId, 'Helena', 'A mysterious figure', undefined, undefined, 'session-1');
        npcRepository.updateNpcEntry(campaignId, 'Bram', 'A gruff blacksmith', undefined, undefined, 'session-1');

        sessionCookie = 'test-session-id';
        await signIn(
            sessionCookie,
            fakeSession([
                { id: MEMBER_GUILD, name: 'My Table', icon: null, canManage: true },
            ]),
        );
        readOnlySessionCookie = 'test-read-only-session-id';
        await signIn(
            readOnlySessionCookie,
            fakeSession([
                { id: MEMBER_GUILD, name: 'My Table', icon: null, canManage: false },
            ]),
        );
    });

    afterAll(async () => {
        await app.close();
    });

    function authedRequest(url: string) {
        return fastify.inject({ method: 'GET', url, headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` } });
    }

    function authedPatch(url: string, payload: Record<string, string>, cookie: string = sessionCookie) {
        return fastify.inject({
            method: 'PATCH',
            url,
            headers: {
                cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
                'content-type': 'application/json',
            },
            payload: JSON.stringify(payload),
        });
    }

    function authedMutation(
        method: 'POST' | 'PATCH' | 'DELETE',
        url: string,
        payload?: Record<string, unknown>,
        cookie: string = sessionCookie,
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

    describe('GET /api/v1/guilds/:guildId', () => {
        it('returns guild info for a guild the user belongs to', async () => {
            const response = await authedRequest(`/api/v1/guilds/${MEMBER_GUILD}`);
            expect(response.statusCode).toBe(200);
            expect(JSON.parse(response.payload)).toEqual({
                id: MEMBER_GUILD,
                name: 'My Table',
                icon: null,
                canManage: true,
            });
        });

        it('returns 403 for a guild the user does not belong to', async () => {
            const response = await authedRequest(`/api/v1/guilds/${OTHER_GUILD}`);
            expect(response.statusCode).toBe(403);
        });

        it('returns 401 without a session', async () => {
            const response = await fastify.inject({ method: 'GET', url: `/api/v1/guilds/${MEMBER_GUILD}` });
            expect(response.statusCode).toBe(401);
        });
    });

    describe('GET /api/v1/guilds/:guildId/campaigns', () => {
        it('lists campaigns for the guild', async () => {
            const response = await authedRequest(`/api/v1/guilds/${MEMBER_GUILD}/campaigns`);
            expect(response.statusCode).toBe(200);
            const campaigns = JSON.parse(response.payload);
            expect(campaigns).toHaveLength(1);
            expect(campaigns[0]).toMatchObject({ id: campaignId, name: 'Test Campaign', currentYear: 1250 });
        });
    });

    describe('GET /api/v1/campaigns/:campaignId', () => {
        it('returns the campaign overview with party and counts', async () => {
            const response = await authedRequest(`/api/v1/campaigns/${campaignId}`);
            expect(response.statusCode).toBe(200);
            const overview = JSON.parse(response.payload);
            expect(overview.id).toBe(campaignId);
            expect(overview.currentYear).toBe(1250);
            expect(overview.party).toEqual([
                { userId: 'pc-1', name: 'Aria', race: null, class: null, image: null },
            ]);
            expect(overview.counts.npcs).toBe(2);
        });

        it('returns 403 when the campaign belongs to a guild the user is not in', async () => {
            const otherCampaignId = campaignRepository.createCampaign(OTHER_GUILD, 'Someone Else\'s Campaign');
            const response = await authedRequest(`/api/v1/campaigns/${otherCampaignId}`);
            expect(response.statusCode).toBe(403);
        });

        it('returns 404 for a campaign that does not exist', async () => {
            const response = await authedRequest('/api/v1/campaigns/999999999');
            expect(response.statusCode).toBe(404);
        });
    });

    describe('GET /api/v1/campaigns/:campaignId/npcs', () => {
        it('lists NPCs in a paginated envelope carrying the unsliced total', async () => {
            const response = await authedRequest(`/api/v1/campaigns/${campaignId}/npcs?limit=1`);
            expect(response.statusCode).toBe(200);
            const body = JSON.parse(response.payload);
            expect(body.items).toHaveLength(1);
            // `total` counts every matching row, not the page — this is what lets the
            // SPA render "1-1 of 2" instead of guessing from items.length.
            expect(body).toMatchObject({ total: 2, limit: 1, offset: 0 });
        });

        it('clamps an out-of-range limit to the max', async () => {
            const response = await authedRequest(`/api/v1/campaigns/${campaignId}/npcs?limit=9999`);
            expect(response.statusCode).toBe(200);
            const body = JSON.parse(response.payload);
            expect(body.limit).toBe(100);
            expect(body.items.length).toBeLessThanOrEqual(100);
            expect(body.items.length).toBe(2);
        });

        it('projects away plumbing columns instead of returning SELECT * rows', async () => {
            const response = await authedRequest(`/api/v1/campaigns/${campaignId}/npcs`);
            const [npc] = JSON.parse(response.payload).items;
            expect(npc).toHaveProperty('short_id');
            expect(npc).toHaveProperty('name');
            for (const leaked of ['rag_sync_needed', 'manual_description', 'first_session_id', 'campaign_id', 'id']) {
                expect(npc).not.toHaveProperty(leaked);
            }
        });
    });

    describe('Inventory categories (VIS-07)', () => {
        it('persists the default category and the campaign/category/item index', () => {
            const column = (db.pragma('table_info(inventory)') as Array<{
                name: string;
                notnull: number;
                dflt_value: string | null;
            }>).find((candidate) => candidate.name === 'category');
            expect(column).toMatchObject({ name: 'category', notnull: 1, dflt_value: "'OTHER'" });

            const index = db.prepare(
                "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_inventory_campaign_category'",
            ).get() as { sql: string } | undefined;
            expect(index?.sql).toContain('(campaign_id, category, item_name)');
        });

        it('returns category in list/detail, filters it, and permits only campaign managers to mutate it', async () => {
            // Deliberately a name the category-guessing heuristic in addLoot
            // (src/utils/inventoryCategory.ts) won't match, so this stays at
            // the schema default until the manager PATCH below sets it.
            const itemName = 'VIS-07 Mystery Trinket';
            inventoryRepository.addLoot(campaignId, itemName, 1, 'vis-07-session', 'Cold silver light');
            const item = inventoryRepository.getInventoryItemByName(campaignId, itemName)!;
            const shortId = item.short_id!;
            expect(item.category).toBe('OTHER');

            const readOnly = await authedPatch(
                `/api/v1/campaigns/${campaignId}/inventory/${shortId}/category`,
                { category: 'WEAPON' },
                readOnlySessionCookie,
            );
            expect(readOnly.statusCode).toBe(403);
            expect(inventoryRepository.getInventoryItemByShortId(campaignId, shortId)?.category).toBe('OTHER');

            const invalid = await authedPatch(
                `/api/v1/campaigns/${campaignId}/inventory/${shortId}/category`,
                { category: 'weapon' },
            );
            expect(invalid.statusCode).toBe(400);

            const updated = await authedPatch(
                `/api/v1/campaigns/${campaignId}/inventory/${shortId}/category`,
                { category: 'WEAPON' },
            );
            expect(updated.statusCode).toBe(200);
            expect(JSON.parse(updated.payload)).toMatchObject({
                short_id: shortId,
                item_name: itemName,
                category: 'WEAPON',
                is_artifact: false,
            });

            const detail = await authedRequest(
                `/api/v1/campaigns/${campaignId}/inventory/${shortId}`,
            );
            expect(detail.statusCode).toBe(200);
            expect(JSON.parse(detail.payload)).toMatchObject({
                short_id: shortId,
                category: 'WEAPON',
                artifact_short_id: null,
                artifact_status: null,
                is_cursed: null,
            });

            const filtered = await authedRequest(
                `/api/v1/campaigns/${campaignId}/inventory?category=WEAPON`,
            );
            expect(filtered.statusCode).toBe(200);
            const filteredBody = JSON.parse(filtered.payload);
            expect(filteredBody.items).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ short_id: shortId, category: 'WEAPON' }),
                ]),
            );
            expect(filteredBody.total).toBe(filteredBody.items.length);

            const invalidFilter = await authedRequest(
                `/api/v1/campaigns/${campaignId}/inventory?category=weapon`,
            );
            expect(invalidFilter.statusCode).toBe(400);
        });

        it('includes category in inventory references on session detail', async () => {
            const sessionId = 'vis-07-category-session';
            const itemName = 'VIS-07 Healing Draught';
            sessionRepository.createSession(sessionId, MEMBER_GUILD, campaignId);
            db.prepare(
                `INSERT INTO recordings (session_id, filename, filepath, user_id, timestamp, status)
                 VALUES (?, ?, ?, ?, ?, 'PROCESSED')`,
            ).run(
                sessionId,
                'vis-07-category-session.flac',
                '/tmp/vis-07-category-session.flac',
                'user-1',
                7_007,
            );
            inventoryRepository.addLoot(campaignId, itemName, 2, sessionId);
            const item = inventoryRepository.getInventoryItemByName(campaignId, itemName)!;
            const shortId = item.short_id!;
            inventoryRepository.updateInventoryCategory(campaignId, shortId, 'CONSUMABLE');

            const response = await authedRequest(
                `/api/v1/campaigns/${campaignId}/sessions/${sessionId}`,
            );
            expect(response.statusCode).toBe(200);
            expect(JSON.parse(response.payload).inventory).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        short_id: shortId,
                        item_name: itemName,
                        quantity: 2,
                        category: 'CONSUMABLE',
                    }),
                ]),
            );

            // Keep this fixture isolated from the navigation ordering assertions
            // in the session-detail contract tests below.
            db.prepare('DELETE FROM inventory WHERE id = ?').run(item.id);
            db.prepare('DELETE FROM recordings WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
        });
    });

    describe('Quest CRUD and canonical enums', () => {
        it('allows campaign managers to create, edit and hard-delete a quest', async () => {
            const payload = {
                title: 'The UI Quest',
                description: 'Created directly from the campaign UI.',
                status: 'OPEN',
                type: 'MINOR',
            };
            const readOnly = await authedMutation(
                'POST',
                `/api/v1/campaigns/${campaignId}/quests`,
                payload,
                readOnlySessionCookie,
            );
            expect(readOnly.statusCode).toBe(403);

            const invalid = await authedMutation(
                'POST',
                `/api/v1/campaigns/${campaignId}/quests`,
                { ...payload, status: 'IN CORSO' },
            );
            expect(invalid.statusCode).toBe(400);

            const createdResponse = await authedMutation(
                'POST',
                `/api/v1/campaigns/${campaignId}/quests`,
                payload,
            );
            expect(createdResponse.statusCode).toBe(201);
            const created = JSON.parse(createdResponse.payload);
            expect(created).toMatchObject({
                title: payload.title,
                status: 'OPEN',
                type: 'MINOR',
            });

            const updatedResponse = await authedMutation(
                'PATCH',
                `/api/v1/campaigns/${campaignId}/quests/${created.short_id}`,
                {
                    ...payload,
                    title: 'The UI Quest Renamed',
                    status: 'IN_PROGRESS',
                },
            );
            expect(updatedResponse.statusCode).toBe(200);
            expect(JSON.parse(updatedResponse.payload)).toMatchObject({
                title: 'The UI Quest Renamed',
                status: 'IN_PROGRESS',
                type: 'MINOR',
            });

            const events = await authedRequest(
                `/api/v1/campaigns/${campaignId}/quests/${created.short_id}/events`,
            );
            expect(events.statusCode).toBe(200);
            expect(JSON.parse(events.payload).items).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ event_type: 'MANUAL_UPDATE' }),
                ]),
            );

            // The delete returns the cascade's report, not a mute 204: the UI
            // has to be able to say what was removed beyond the entity row.
            const removed = await authedMutation(
                'DELETE',
                `/api/v1/campaigns/${campaignId}/quests/${created.short_id}`,
            );
            expect(removed.statusCode).toBe(200);
            expect(JSON.parse(removed.payload)).toMatchObject({
                name: 'The UI Quest Renamed',
                report: expect.objectContaining({ rag_fragments_deleted: expect.any(Number) }),
            });
            const missing = await authedRequest(
                `/api/v1/campaigns/${campaignId}/quests/${created.short_id}`,
            );
            expect(missing.statusCode).toBe(404);
        });

        it('estimates the quest audit without invoking AI and exposes the configured model', async () => {
            const sessionId = 'quest-audit-estimate-session';
            sessionRepository.createSession(sessionId, MEMBER_GUILD, campaignId);
            sessionRepository.setSessionNumber(sessionId, 99);
            db.prepare(
                `INSERT INTO recordings (
                    session_id, filename, filepath, user_id, timestamp, status, transcription_text
                ) VALUES (?, ?, ?, ?, ?, 'PROCESSED', ?)`,
            ).run(
                sessionId,
                'quest-audit-estimate.flac',
                '/tmp/quest-audit-estimate.flac',
                'user-1',
                99_000,
                'The party completed a chapter.',
            );
            questRepository.addQuest(
                campaignId,
                'Quest audit estimate fixture',
                sessionId,
                'A quest included in the cost estimate.',
            );

            const readOnly = await fastify.inject({
                method: 'GET',
                url: `/api/v1/campaigns/${campaignId}/quests/lifecycle-audit/estimate`,
                headers: { cookie: `${SESSION_COOKIE_NAME}=${readOnlySessionCookie}` },
            });
            expect(readOnly.statusCode).toBe(403);

            const response = await authedRequest(
                `/api/v1/campaigns/${campaignId}/quests/lifecycle-audit/estimate`,
            );
            expect(response.statusCode).toBe(200);
            const body = JSON.parse(response.payload);
            expect(body).toMatchObject({
                status: 'READY',
                will_invoke_ai: true,
                billable: true,
                pricing_available: true,
                provider: expect.any(String),
                model: expect.any(String),
                session_count: expect.any(Number),
                open_quest_count: expect.any(Number),
                exchange_rate: {
                    source: 'ECB',
                    usd_per_eur: 1.1,
                    rate_date: '2026-07-27',
                },
            });
            expect(body.session_count).toBeGreaterThanOrEqual(1);
            expect(body.open_quest_count).toBeGreaterThanOrEqual(1);
            expect(body.estimated_tokens.input_max).toBeGreaterThan(body.estimated_tokens.input_min);
            expect(body.estimated_cost_eur.max).toBeGreaterThan(body.estimated_cost_eur.min);

            db.prepare('DELETE FROM quest_history WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM quests WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM recordings WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
        });

        it('returns and persists measured audit cost, then reuses cooldown without another AI call', async () => {
            const sessionId = 'quest-audit-cost-session';
            sessionRepository.createSession(sessionId, MEMBER_GUILD, campaignId);
            sessionRepository.setSessionNumber(sessionId, 100);
            db.prepare(
                `INSERT INTO recordings (
                    session_id, filename, filepath, user_id, timestamp, status, transcription_text
                ) VALUES (?, ?, ?, ?, ?, 'PROCESSED', ?)`,
            ).run(
                sessionId,
                'quest-audit-cost.flac',
                '/tmp/quest-audit-cost.flac',
                'user-1',
                100_000,
                'The party reviewed its unresolved goals.',
            );
            questRepository.addQuest(
                campaignId,
                'Quest audit cost fixture',
                sessionId,
                'An unresolved quest used to exercise audit billing.',
            );
            mockRunHistoricalQuestAuditAgent.mockResolvedValueOnce({
                data: { decisions: [] },
                debug: '[]',
                tokens: {
                    input: 1_000,
                    output: 100,
                    inputChars: 4_000,
                    outputChars: 400,
                    cached: 0,
                },
                provider: 'gemini',
                model: 'gemini-3.1-pro-preview',
            });

            const before = db.prepare(
                `SELECT COALESCE(ai_cost_usd, 0) AS cost_usd, ai_cost_eur AS cost_eur
                 FROM usage_tracking WHERE guild_id = ? AND month = strftime('%Y-%m', 'now')`,
            ).get(MEMBER_GUILD) as { cost_usd: number; cost_eur: number | null } | undefined;
            const response = await authedMutation(
                'POST',
                `/api/v1/campaigns/${campaignId}/quests/lifecycle-audit`,
            );
            // Accepted, not done: the audit reads every session summary the
            // table has, which is no work to hold an HTTP connection open for.
            expect(response.statusCode).toBe(202);
            const body = JSON.parse(response.payload);
            expect(body).toMatchObject({ invoked_ai: true, skipped_reason: null });
            expect(body.job_id).toEqual(expect.any(String));
            await app.get(AiJobRunnerProvider).instance.waitForIdle();

            const job = JSON.parse((await fastify.inject({
                method: 'GET',
                url: `/api/v1/campaigns/${campaignId}/ai-jobs/${body.job_id}`,
                headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
            })).payload);
            expect(job.status).toBe('succeeded');
            expect(job.model).toBe('gemini-3.1-pro-preview');
            expect(job.cost_usd).toBeCloseTo(0.0032);
            expect(job.cost_eur).toBeCloseTo(0.0032 / 1.1);
            expect(
                db.prepare(
                    `SELECT phase, provider, model, cost_usd, cost_eur,
                            usd_per_eur, exchange_rate_source, exchange_rate_date
                     FROM ai_usage_log
                     WHERE campaign_id = ? AND phase = 'quest-history-audit'
                     ORDER BY id DESC LIMIT 1`,
                ).get(campaignId),
            ).toMatchObject({
                phase: 'quest-history-audit',
                provider: 'gemini',
                model: 'gemini-3.1-pro-preview',
                cost_usd: expect.closeTo(0.0032),
                cost_eur: expect.closeTo(0.0032 / 1.1),
                usd_per_eur: 1.1,
                exchange_rate_source: 'ECB',
                exchange_rate_date: '2026-07-27',
            });
            const after = db.prepare(
                `SELECT ai_cost_usd AS cost_usd, ai_cost_eur AS cost_eur
                 FROM usage_tracking WHERE guild_id = ? AND month = strftime('%Y-%m', 'now')`,
            ).get(MEMBER_GUILD) as { cost_usd: number; cost_eur: number | null };
            expect(after.cost_usd - (before?.cost_usd || 0)).toBeCloseTo(0.0032);
            if ((before?.cost_usd || 0) === 0 || before?.cost_eur != null) {
                expect((after.cost_eur || 0) - (before?.cost_eur || 0))
                    .toBeCloseTo(0.0032 / 1.1);
            } else {
                expect(after.cost_eur).toBeNull();
            }

            const cooldown = await authedMutation(
                'POST',
                `/api/v1/campaigns/${campaignId}/quests/lifecycle-audit`,
            );
            expect(cooldown.statusCode).toBe(202);
            // The cooldown is read from the register now, so a restart no longer
            // hands out a free second run of an agent on the table's account.
            expect(JSON.parse(cooldown.payload)).toMatchObject({
                job_id: null,
                invoked_ai: false,
                skipped_reason: 'COOLDOWN',
            });
            expect(mockRunHistoricalQuestAuditAgent).toHaveBeenCalledTimes(1);

            db.prepare('DELETE FROM ai_job WHERE campaign_id = ?').run(campaignId);

            db.prepare(
                `DELETE FROM ai_usage_log
                 WHERE campaign_id = ? AND phase = 'quest-history-audit'`,
            ).run(campaignId);
            db.prepare(
                `UPDATE usage_tracking SET ai_cost_usd = ?, ai_cost_eur = ?
                 WHERE guild_id = ? AND month = strftime('%Y-%m', 'now')`,
            ).run(before?.cost_usd || 0, before?.cost_eur ?? null, MEMBER_GUILD);
            db.prepare('DELETE FROM quest_history WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM quests WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM recordings WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
        });
    });

    describe('Entity detail + event history endpoints (the web app\'s data map)', () => {
        it('NPC: detail by short_id, events, 404 for unknown short_id', async () => {
            const npc = npcRepository.getNpcEntry(campaignId, 'Helena')!;
            npcRepository.addNpcEvent(campaignId, 'Helena', 'session-1', 'First appeared in the tavern', 'FIRST_APPEARANCE');

            const detail = await authedRequest(`/api/v1/campaigns/${campaignId}/npcs/${npc.short_id}`);
            expect(detail.statusCode).toBe(200);
            expect(JSON.parse(detail.payload).name).toBe('Helena');

            const events = await authedRequest(`/api/v1/campaigns/${campaignId}/npcs/${npc.short_id}/events`);
            expect(events.statusCode).toBe(200);
            expect(JSON.parse(events.payload).items.length).toBeGreaterThanOrEqual(1);

            const notFound = await authedRequest(`/api/v1/campaigns/${campaignId}/npcs/zzzzz`);
            expect(notFound.statusCode).toBe(404);
        });

        it('Location: detail, atlas events (not the travel log), and the separate travels endpoint', async () => {
            locationRepository.updateAtlasEntry(campaignId, 'Ashvale', 'Old Market', 'A bustling market square', 'session-1');
            locationRepository.addAtlasEvent(campaignId, 'Ashvale', 'Old Market', 'session-1', 'A fire broke out', 'GENERIC');
            const location = locationRepository.getAtlasEntryFull(campaignId, 'Ashvale', 'Old Market')!;

            const detail = await authedRequest(`/api/v1/campaigns/${campaignId}/locations/${location.short_id}`);
            expect(detail.statusCode).toBe(200);

            const events = await authedRequest(`/api/v1/campaigns/${campaignId}/locations/${location.short_id}/events`);
            expect(events.statusCode).toBe(200);
            expect(JSON.parse(events.payload).items.length).toBeGreaterThanOrEqual(1);

            locationRepository.updateLocation(campaignId, 'Ashvale', 'Old Market', 'session-1');
            const travels = await authedRequest(`/api/v1/campaigns/${campaignId}/travels`);
            expect(travels.statusCode).toBe(200);
            expect(JSON.parse(travels.payload).length).toBeGreaterThanOrEqual(1);
        });

        it('Faction: detail + events', async () => {
            const faction = factionRepository.createFaction(campaignId, 'The Ashen Circle', { description: 'A secretive cabal' })!;
            factionRepository.addFactionEvent(campaignId, 'The Ashen Circle', 'session-1', 'Made contact with the party', 'GENERIC', false, 0, 0, 0);

            const detail = await authedRequest(`/api/v1/campaigns/${campaignId}/factions/${faction.short_id}`);
            expect(detail.statusCode).toBe(200);

            const events = await authedRequest(`/api/v1/campaigns/${campaignId}/factions/${faction.short_id}/events`);
            expect(events.statusCode).toBe(200);
            expect(JSON.parse(events.payload).items.length).toBeGreaterThanOrEqual(1);
        });

        it('Quest: detail + events', async () => {
            questRepository.addQuest(campaignId, 'Find the Lost Amulet', 'session-1', 'Recover the amulet from the ruins');
            questRepository.addQuestEvent(campaignId, 'Find the Lost Amulet', 'session-1', 'Located the ruins entrance', 'PROGRESS');
            const quest = questRepository.getQuestByTitle(campaignId, 'Find the Lost Amulet')!;

            const detail = await authedRequest(`/api/v1/campaigns/${campaignId}/quests/${quest.short_id}`);
            expect(detail.statusCode).toBe(200);

            const events = await authedRequest(`/api/v1/campaigns/${campaignId}/quests/${quest.short_id}/events`);
            expect(events.statusCode).toBe(200);
            expect(JSON.parse(events.payload).items.length).toBeGreaterThanOrEqual(1);
        });

        it('Inventory item: detail + events', async () => {
            inventoryRepository.addLoot(campaignId, 'Silver Dagger', 1, 'session-1', 'A finely crafted dagger');
            inventoryRepository.addInventoryEvent(campaignId, 'Silver Dagger', 'session-1', 'Found in the chest', 'LOOT');
            const item = inventoryRepository.getInventoryItemByName(campaignId, 'Silver Dagger')!;

            const detail = await authedRequest(`/api/v1/campaigns/${campaignId}/inventory/${item.short_id}`);
            expect(detail.statusCode).toBe(200);

            const events = await authedRequest(`/api/v1/campaigns/${campaignId}/inventory/${item.short_id}/events`);
            expect(events.statusCode).toBe(200);
            expect(JSON.parse(events.payload).items.length).toBeGreaterThanOrEqual(1);
        });

        it('Artifact: detail + events', async () => {
            artifactRepository.upsertArtifact(campaignId, 'Crown of Whispers', 'FUNCTIONAL', 'session-1', { description: 'Hums faintly' });
            artifactRepository.addArtifactEvent(campaignId, 'Crown of Whispers', 'session-1', 'The crown began to glow', 'OBSERVATION');
            const artifact = artifactRepository.getArtifactByName(campaignId, 'Crown of Whispers')!;

            const detail = await authedRequest(`/api/v1/campaigns/${campaignId}/artifacts/${artifact.short_id}`);
            expect(detail.statusCode).toBe(200);

            const events = await authedRequest(`/api/v1/campaigns/${campaignId}/artifacts/${artifact.short_id}/events`);
            expect(events.statusCode).toBe(200);
            expect(JSON.parse(events.payload).items.length).toBeGreaterThanOrEqual(1);
        });

        it('Bestiary: detail + events', async () => {
            bestiaryRepository.upsertMonster(campaignId, 'Cave Troll', 'ALIVE', 'session-1');
            bestiaryRepository.addBestiaryEvent(campaignId, 'Cave Troll', 'session-1', 'Encountered near the cave mouth', 'ENCOUNTER');
            const monster = bestiaryRepository.getMonsterByName(campaignId, 'Cave Troll')!;

            const detail = await authedRequest(`/api/v1/campaigns/${campaignId}/bestiary/${monster.short_id}`);
            expect(detail.statusCode).toBe(200);
            expect(JSON.parse(detail.payload)).not.toHaveProperty('count');

            const events = await authedRequest(`/api/v1/campaigns/${campaignId}/bestiary/${monster.short_id}/events`);
            expect(events.statusCode).toBe(200);
            expect(JSON.parse(events.payload).items.length).toBeGreaterThanOrEqual(1);
        });

        it('Timeline: single-event detail by short_id (no separate history — the row IS the event)', async () => {
            worldRepository.addWorldEvent(campaignId, 'session-1', 'The kingdom fell to civil war', 'POLITICS', 1250);
            const [event] = worldRepository.getWorldTimeline(campaignId).slice(-1);

            const detail = await authedRequest(`/api/v1/campaigns/${campaignId}/timeline/${event.short_id}`);
            expect(detail.statusCode).toBe(200);
            expect(JSON.parse(detail.payload).description).toBe('The kingdom fell to civil war');

            const notFound = await authedRequest(`/api/v1/campaigns/${campaignId}/timeline/zzzzz`);
            expect(notFound.statusCode).toBe(404);
        });

        it('Character: detail (with alignment fields) + events, 404 for unknown user', async () => {
            characterRepository.updateUserCharacter('pc-1', campaignId, 'race', 'Elf');
            characterRepository.addCharacterEvent(campaignId, 'Aria', 'session-1', 'Discovered her hidden past', 'BACKGROUND');

            const detail = await authedRequest(`/api/v1/campaigns/${campaignId}/characters/pc-1`);
            expect(detail.statusCode).toBe(200);
            const body = JSON.parse(detail.payload);
            expect(body).toMatchObject({ userId: 'pc-1', character_name: 'Aria', race: 'Elf' });

            const events = await authedRequest(`/api/v1/campaigns/${campaignId}/characters/pc-1/events`);
            expect(events.statusCode).toBe(200);
            expect(JSON.parse(events.payload).items.length).toBeGreaterThanOrEqual(1);

            const notFound = await authedRequest(`/api/v1/campaigns/${campaignId}/characters/no-such-user`);
            expect(notFound.statusCode).toBe(404);
        });

        // email is the only non-lore column on `characters`: a campaign member must not
        // be able to read another player's address by walking the roster.
        it('Character: email is returned to its owner only, never to other campaign members', async () => {
            characterRepository.updateUserCharacter('pc-1', campaignId, 'email', 'aria@example.test');
            characterRepository.updateUserCharacter('user-1', campaignId, 'character_name', 'Tester');
            characterRepository.updateUserCharacter('user-1', campaignId, 'email', 'tester@example.test');

            // Session belongs to 'user-1' (see fakeSession), so 'pc-1' is somebody else.
            const other = await authedRequest(`/api/v1/campaigns/${campaignId}/characters/pc-1`);
            expect(other.statusCode).toBe(200);
            const otherBody = JSON.parse(other.payload);
            expect(otherBody.character_name).toBe('Aria');
            expect(otherBody).not.toHaveProperty('email');

            const self = await authedRequest(`/api/v1/campaigns/${campaignId}/characters/user-1`);
            expect(self.statusCode).toBe(200);
            expect(JSON.parse(self.payload)).toMatchObject({
                userId: 'user-1',
                email: 'tester@example.test',
            });
        });

        it('Session: detail exposes enriched navigation, participants and media state', async () => {
            const sessions = [
                { id: 'sess-detail-prev', number: 41 },
                { id: 'sess-detail-1', number: 42 },
                { id: 'sess-detail-next', number: 43 },
            ];
            for (const session of sessions) {
                sessionRepository.createSession(session.id, MEMBER_GUILD, campaignId);
                sessionRepository.setSessionNumber(session.id, session.number);
                sessionRepository.updateSessionTitle(session.id, `Chapter ${session.number}`);
            }

            characterRepository.updateUserCharacter('speaker-b', campaignId, 'character_name', 'Borin');
            db.prepare(
                `INSERT INTO recordings (
                    session_id, filename, filepath, user_id, timestamp, status,
                    transcription_text, character_name_snapshot, macro_location, micro_location
                ) VALUES (?, ?, ?, ?, ?, 'PROCESSED', ?, ?, ?, ?)`,
            ).run(
                'sess-detail-1',
                'session-detail-a-late.flac',
                '/tmp/session-detail-a-late.flac',
                'speaker-a',
                4_000,
                'Second intervention',
                'Alyra',
                'North',
                'Tower',
            );
            db.prepare(
                `INSERT INTO recordings (
                    session_id, filename, filepath, user_id, timestamp, status,
                    transcription_text, character_name_snapshot, macro_location, micro_location
                ) VALUES (?, ?, ?, ?, ?, 'PROCESSED', ?, ?, ?, ?)`,
            ).run(
                'sess-detail-1',
                'session-detail-b-first.flac',
                '/tmp/session-detail-b-first.flac',
                'speaker-b',
                2_000,
                'First intervention',
                null,
                'South',
                'Gate',
            );
            db.prepare(
                `INSERT INTO recordings (
                    session_id, filename, filepath, user_id, timestamp, status,
                    transcription_text, character_name_snapshot
                ) VALUES (?, ?, ?, ?, ?, 'PROCESSED', ?, ?)`,
            ).run(
                'sess-detail-1',
                'session-detail-a-repeat.flac',
                '/tmp/session-detail-a-repeat.flac',
                'speaker-a',
                3_000,
                'Middle intervention',
                'Alyra',
            );
            db.prepare(
                `INSERT INTO recordings (session_id, filename, filepath, user_id, timestamp, status)
                 VALUES (?, ?, ?, ?, ?, 'PROCESSED')`,
            ).run(
                'sess-detail-prev',
                'session-detail-prev.flac',
                '/tmp/session-detail-prev.flac',
                'speaker-a',
                1_000,
            );
            db.prepare(
                `INSERT INTO recordings (session_id, filename, filepath, user_id, timestamp, status)
                 VALUES (?, ?, ?, ?, ?, 'PROCESSED')`,
            ).run(
                'sess-detail-next',
                'session-detail-next.flac',
                '/tmp/session-detail-next.flac',
                'speaker-a',
                5_000,
            );
            mockCloudObjectExists.mockResolvedValueOnce(true);

            const detail = await authedRequest(`/api/v1/campaigns/${campaignId}/sessions/sess-detail-1`);
            expect(detail.statusCode).toBe(200);
            const body = JSON.parse(detail.payload);
            expect(body.session_id).toBe('sess-detail-1');
            expect(body).toHaveProperty('brief');
            expect(body).toHaveProperty('narrative');
            expect(body.navigation).toEqual({
                previous: {
                    session_id: 'sess-detail-prev',
                    start_time: 1_000,
                    session_number: 41,
                    title: 'Chapter 41',
                },
                next: {
                    session_id: 'sess-detail-next',
                    start_time: 5_000,
                    session_number: 43,
                    title: 'Chapter 43',
                },
            });
            expect(body.participants).toEqual([
                { userId: 'speaker-b', characterName: 'Borin', image: null },
                { userId: 'speaker-a', characterName: 'Alyra', image: null },
            ]);
            expect(body.media).toEqual({ audioAvailable: true, transcriptAvailable: true });
            expect(sessionRepository.getSessionNavigation(campaignId, 'sess-detail-prev').previous).toBeNull();
            expect(sessionRepository.getSessionNavigation(campaignId, 'sess-detail-next').next).toBeNull();

            const notFound = await authedRequest(`/api/v1/campaigns/${campaignId}/sessions/no-such-session`);
            expect(notFound.statusCode).toBe(404);
        });

        it('Session transcript is chronological and keeps speaker and location context', async () => {
            const response = await authedRequest(
                `/api/v1/campaigns/${campaignId}/sessions/sess-detail-1/transcript`,
            );
            expect(response.statusCode).toBe(200);
            expect(JSON.parse(response.payload)).toEqual({
                items: [
                    {
                        text: 'First intervention',
                        userId: 'speaker-b',
                        characterName: null,
                        timestamp: 2_000,
                        macroLocation: 'South',
                        microLocation: 'Gate',
                    },
                    {
                        text: 'Middle intervention',
                        userId: 'speaker-a',
                        characterName: 'Alyra',
                        timestamp: 3_000,
                        macroLocation: null,
                        microLocation: null,
                    },
                    {
                        text: 'Second intervention',
                        userId: 'speaker-a',
                        characterName: 'Alyra',
                        timestamp: 4_000,
                        macroLocation: 'North',
                        microLocation: 'Tower',
                    },
                ],
            });
        });

        it('Session transcript normalizes Whisper JSON segments into readable text', async () => {
            sessionRepository.createSession('sess-json-transcript', MEMBER_GUILD, campaignId);
            db.prepare(
                `INSERT INTO recordings (
                    session_id, filename, filepath, user_id, timestamp, status, transcription_text
                ) VALUES (?, ?, ?, ?, ?, 'PROCESSED', ?)`,
            ).run(
                'sess-json-transcript',
                'session-json.flac',
                '/tmp/session-json.flac',
                'speaker-json',
                1_000,
                JSON.stringify([
                    { start: 0.49, end: 0.83, text: 'Bye!' },
                    { start: 3.14, end: 66.38, text: 'Long sentence.' },
                ]),
            );

            const response = await authedRequest(
                `/api/v1/campaigns/${campaignId}/sessions/sess-json-transcript/transcript`,
            );
            expect(response.statusCode).toBe(200);
            const body = JSON.parse(response.payload);
            expect(body.items).toHaveLength(1);
            expect(body.items[0]).toMatchObject({
                text: 'Bye! Long sentence.',
                userId: 'speaker-json',
                timestamp: 1_000,
            });
        });

        it('Session audio redirects to a five-minute signed URL and returns 404 when missing', async () => {
            mockGetPresignedUrl.mockResolvedValueOnce('https://storage.example.test/signed-master');
            const found = await authedRequest(`/api/v1/campaigns/${campaignId}/sessions/sess-detail-1/audio`);
            expect(found.statusCode).toBe(302);
            expect(found.headers.location).toBe('https://storage.example.test/signed-master');
            expect(mockGetPresignedUrl).toHaveBeenLastCalledWith(
                'recordings/sess-detail-1/session_sess-detail-1_master.mp3',
                undefined,
                300,
            );

            mockGetPresignedUrl.mockResolvedValueOnce(null);
            const missing = await authedRequest(`/api/v1/campaigns/${campaignId}/sessions/sess-detail-1/audio`);
            expect(missing.statusCode).toBe(404);
        });

        it('Session child resources reject a session belonging to another campaign before storage access', async () => {
            const otherCampaignId = campaignRepository.createCampaign(MEMBER_GUILD, 'Other same-guild campaign');
            sessionRepository.createSession('sess-other-campaign', MEMBER_GUILD, otherCampaignId);
            db.prepare(
                `INSERT INTO recordings (session_id, filename, filepath, user_id, timestamp, status, transcription_text)
                 VALUES (?, ?, ?, ?, ?, 'PROCESSED', ?)`,
            ).run(
                'sess-other-campaign',
                'session-other-campaign.flac',
                '/tmp/session-other-campaign.flac',
                'speaker-x',
                6_000,
                'Private to the other campaign',
            );

            const transcript = await authedRequest(
                `/api/v1/campaigns/${campaignId}/sessions/sess-other-campaign/transcript`,
            );
            expect(transcript.statusCode).toBe(404);

            const signerCalls = mockGetPresignedUrl.mock.calls.length;
            const audio = await authedRequest(
                `/api/v1/campaigns/${campaignId}/sessions/sess-other-campaign/audio`,
            );
            expect(audio.statusCode).toBe(404);
            expect(mockGetPresignedUrl).toHaveBeenCalledTimes(signerCalls);
        });
    });

});
