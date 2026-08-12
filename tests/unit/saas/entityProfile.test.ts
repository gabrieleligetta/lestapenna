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

jest.mock('../../../src/services/backup', () => ({
    ...jest.requireActual('../../../src/services/backup'),
    cloudObjectExists: jest.fn().mockResolvedValue(false),
}));

/** The provider is the one thing a test must never reach. */
const mockRunAgent: any = jest.fn();
jest.mock('../../../src/bard/agent/runtime', () => ({
    ...jest.requireActual('../../../src/bard/agent/runtime'),
    runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

jest.mock('../../../src/bard/config', () => ({
    ...jest.requireActual('../../../src/bard/config'),
    getAnalystClient: jest.fn().mockResolvedValue({
        client: {},
        model: 'gemini-3-flash-preview',
        provider: 'gemini',
        creds: { provider: 'gemini', apiKey: null, source: 'tenant', secretKey: 'gemini.apiKey', scope: {} },
        scope: { guildId: 'profile-guild' },
    }),
}));

jest.mock('../../../src/bard/rag/search', () => ({
    ...jest.requireActual('../../../src/bard/rag/search'),
    searchKnowledge: jest.fn().mockResolvedValue([]),
}));

import type { FastifyInstance } from 'fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createNestApp } from '../../../src/api/main';
import { type WebSessionData } from '../../../src/api/auth/webSession.store';
import { signIn } from '../../fixtures/signIn';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { npcRepository } from '../../../src/db/repositories/NpcRepository';
import { entityProfileRepository } from '../../../src/db/repositories/EntityProfileRepository';
import { db } from '../../../src/db';
import { AiJobRunnerProvider } from '../../../src/api/aiJobs/aiJobRunner.provider';

const GUILD_ID = 'profile-guild';
const MANAGER_ID = 'profile-manager';
const READER_ID = 'profile-reader';

function webSession(discordUserId: string, canManage: boolean): WebSessionData {
    return {
        discordUserId,
        username: discordUserId,
        globalName: null,
        avatar: null,
        accessToken: 'irrelevant',
        refreshToken: 'irrelevant',
        tokenExpiresAt: Date.now() + 999_999_999,
        guilds: [{ id: GUILD_ID, name: 'Profile Guild', icon: null, canManage }],
        guildsFetchedAt: Date.now(),
    };
}

/**
 * The appearance dossier over HTTP.
 *
 * The cases that matter are the ones where being wrong is expensive or
 * dishonest: a trait kept without evidence, a hand-written dossier overwritten
 * by a regeneration, a rate we do not know reported as zero.
 */
describe('Entity appearance dossier', () => {
    let app: NestFastifyApplication;
    let fastify: FastifyInstance;
    let campaignId: number;
    let managerCookie: string;
    let readerCookie: string;
    let npcShortId: string;

    beforeAll(async () => {
        app = await createNestApp();
        await app.init();
        fastify = app.getHttpAdapter().getInstance();

        campaignId = campaignRepository.createCampaign(GUILD_ID, 'Profile Campaign');
        npcRepository.updateNpcEntry(campaignId, `Astrid ${process.pid}`, 'Commander of the Iron Maidens');
        npcShortId = (db.prepare(
            'SELECT short_id FROM npc_dossier WHERE campaign_id = ?',
        ).get(campaignId) as { short_id: string }).short_id;

        managerCookie = 'profile-manager-session';
        readerCookie = 'profile-reader-session';
        await signIn(managerCookie, webSession(MANAGER_ID, true));
        await signIn(readerCookie, webSession(READER_ID, false));
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        db.prepare('DELETE FROM entity_profile WHERE campaign_id = ?').run(campaignId);
        db.prepare('DELETE FROM ai_usage_log WHERE campaign_id = ?').run(campaignId);
        db.prepare('DELETE FROM ai_job WHERE campaign_id = ?').run(campaignId);

        mockRunAgent.mockResolvedValue({
            output: {
                traits: [
                    {
                        field: 'hair.colour',
                        value: 'white',
                        evidence: 'ha i capelli bianchi',
                        source: 'transcript',
                        session: '12',
                        confidence: 'HIGH',
                    },
                    {
                        field: 'armour.type',
                        value: 'plate cuirass over a long gown',
                        evidence: 'the Vergini di Ferro wear a cuirass over a gown',
                        source: 'faction',
                        confidence: 'MEDIUM',
                    },
                ],
                personality: [],
                not_recorded: ['eyes'],
            },
            transcript: [],
            turns: 2,
            usage: { input: 4200, output: 380, inputChars: 0, outputChars: 0, cached: 0 },
        });
    });

    const path = (suffix = '') =>
        `/api/v1/campaigns/${campaignId}/npc/${npcShortId}/profile${suffix}`;

    const analyzeRequest = (cookie = managerCookie) => fastify.inject({
        method: 'POST',
        url: path('/analyze'),
        headers: { cookie: `lp_session=${cookie}` },
    });

    /**
     * Asks for an analysis and lets it finish.
     *
     * The dossier is read back with a second request, which is the same one a
     * browser makes after being reconnected — the property the register exists
     * to give this action.
     */
    async function analyze(cookie = managerCookie) {
        const accepted = await analyzeRequest(cookie);
        if (accepted.statusCode !== 202) return { accepted, job: null as any };
        await app.get(AiJobRunnerProvider).instance.waitForIdle();
        const read = await fastify.inject({
            method: 'GET',
            url: `/api/v1/campaigns/${campaignId}/ai-jobs/${accepted.json().job_id}`,
            headers: { cookie: `lp_session=${cookie}` },
        });
        return { accepted, job: read.json() };
    }

    /** The stored dossier, as the sheet reads it. */
    async function readProfile(cookie = managerCookie) {
        const response = await fastify.inject({
            method: 'GET', url: path(), headers: { cookie: `lp_session=${cookie}` },
        });
        return response.json();
    }

    it('answers with an empty dossier, and the fields it could hold', async () => {
        const response = await fastify.inject({
            method: 'GET',
            url: path(),
            headers: { cookie: `lp_session=${managerCookie}` },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.appearance).toBeNull();
        // The vocabulary is served so the sheet can offer a form to fill in by
        // hand before any AI has ever run — the free path through this feature.
        expect(body.kind).toBe('person');
        expect(body.fields).toEqual(expect.arrayContaining(['hair.colour', 'eyes', 'personality.manner']));
        expect(body.manual_fields).toEqual([]);
    });

    it('lets a person write the dossier by hand, with no model called', async () => {
        const written = await fastify.inject({
            method: 'PATCH',
            url: path(),
            headers: { cookie: `lp_session=${managerCookie}`, 'content-type': 'application/json' },
            payload: { fields: { eyes: 'amber', weapons: ['longsword'] } },
        });

        expect(written.statusCode).toBe(200);
        expect(written.json().appearance).toEqual({ eyes: 'amber', weapons: ['longsword'] });
        expect(written.json().manual_fields.sort()).toEqual(['eyes', 'weapons']);
        expect(mockRunAgent).not.toHaveBeenCalled();
        expect(db.prepare('SELECT COUNT(*) n FROM ai_usage_log WHERE campaign_id = ?')
            .get(campaignId)).toEqual({ n: 0 });
    });

    it('refuses a field that does not exist for this kind of subject', async () => {
        const response = await fastify.inject({
            method: 'PATCH',
            url: path(),
            headers: { cookie: `lp_session=${managerCookie}`, 'content-type': 'application/json' },
            payload: { fields: { horns: 'curving back like a ram' } },
        });

        expect(response.statusCode).toBe(400);
    });

    it('stores the evidenced traits and reports what the records do not hold', async () => {
        const { accepted, job } = await analyze();

        expect(accepted.statusCode).toBe(202);
        expect(job.status).toBe('succeeded');
        expect(job.result.not_recorded).toEqual(['eyes']);

        const profile = await readProfile();
        expect(profile.appearance).toEqual({
            hair: { colour: 'white' },
            armour: { type: 'plate cuirass over a long gown' },
        });
        expect(profile.evidence).toHaveLength(2);
        // The weakest claim decides: the livery is inherited, not stated of her.
        expect(profile.confidence).toBe('MEDIUM');
    });

    it('drops a trait the model could not evidence, however sure it sounded', async () => {
        mockRunAgent.mockResolvedValue({
            output: {
                traits: [
                    { field: 'eyes', value: 'solid gold, no pupils', source: 'rag', confidence: 'HIGH' },
                    { field: 'face_marks', value: 'a scar across the nose', evidence: '', source: 'rag', confidence: 'HIGH' },
                ],
                personality: [],
                not_recorded: [],
            },
            transcript: [],
            turns: 1,
            usage: { input: 100, output: 20, inputChars: 0, outputChars: 0, cached: 0 },
        });

        await analyze();

        const profile = await readProfile();
        expect(profile.appearance).toBeNull();
        expect(profile.evidence).toEqual([]);
    });

    it('writes what the analysis actually cost to the ledger', async () => {
        await analyze();

        const rows = db.prepare(
            'SELECT phase, provider, model, cost_usd, pricing_source FROM ai_usage_log WHERE campaign_id = ?',
        ).all(campaignId) as any[];

        expect(rows).toHaveLength(1);
        expect(rows[0].phase).toBe('appearance');
        expect(rows[0].cost_usd).toBeGreaterThan(0);
        expect(rows[0].pricing_source).toBeTruthy();
    });

    it('quotes a range before spending, without touching a credential', async () => {
        const response = await fastify.inject({
            method: 'GET',
            url: path('/analyze/estimate'),
            headers: { cookie: `lp_session=${managerCookie}` },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.billable).toBe(true);
        expect(body.estimated_cost_usd.max).toBeGreaterThanOrEqual(body.estimated_cost_usd.min);
        expect(mockRunAgent).not.toHaveBeenCalled();
    });

    it('fills what nobody owns and steps around what somebody wrote', async () => {
        const written = await fastify.inject({
            method: 'PATCH',
            url: path(),
            headers: { cookie: `lp_session=${managerCookie}`, 'content-type': 'application/json' },
            payload: { fields: { 'hair.colour': 'silver' } },
        });
        expect(written.statusCode).toBe(200);
        expect(written.json().is_manual).toBe(true);

        const { job } = await analyze();

        // Per field, not per record: the analysis adds the armour it found and
        // leaves the hair colour a person chose. Freezing the whole dossier
        // would punish the very people with the most to add.
        expect(job.result.kept_fields).toEqual(['hair.colour']);
        expect((await readProfile()).appearance).toMatchObject({
            hair: { colour: 'silver' },
            armour: { type: 'plate cuirass over a long gown' },
        });
        expect(job.cost_usd).toBeGreaterThan(0);
    });

    it('refuses a reader, who may look at the sheet but not spend on it', async () => {
        const response = await analyzeRequest(readerCookie);

        expect(response.statusCode).toBe(403);
        expect(entityProfileRepository.getForEntity(campaignId, 'npc', npcShortId)).toBeNull();
    });

    it('is a fact about the request, not a server failure, when the subject does not exist', async () => {
        const response = await fastify.inject({
            method: 'POST',
            url: `/api/v1/campaigns/${campaignId}/npc/zzzzz/profile/analyze`,
            headers: { cookie: `lp_session=${managerCookie}` },
        });

        expect(response.statusCode).toBe(404);
    });

    it('records an overloaded provider as an upstream failure, not as a bug of ours', async () => {
        const overloaded: any = new Error(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE' } }));
        overloaded.status = 503;
        mockRunAgent.mockRejectedValueOnce(overloaded);

        const { job } = await analyze(managerCookie);

        expect(job.status).toBe('failed');
        expect(job.error_kind).toBe('provider');
        // A run that never produced traits leaves no dossier and no ledger row.
        expect(entityProfileRepository.getForEntity(campaignId, 'npc', npcShortId)).toBeNull();
        expect(job.charged).toBe(false);
    });

    it('does not analyse the same subject twice at once', async () => {
        let release: (value: unknown) => void = () => {};
        mockRunAgent.mockImplementation(() => new Promise((resolve) => {
            release = resolve;
        }));

        const first = await analyzeRequest();
        expect(first.statusCode).toBe(202);
        // The lock is the database now: it holds from the moment the row exists,
        // before any agent is reached, and it survives a restart.
        expect((await analyzeRequest()).statusCode).toBe(409);

        release({
            output: { traits: [], personality: [], not_recorded: [] },
            transcript: [],
            turns: 1,
            usage: { input: 10, output: 5, inputChars: 0, outputChars: 0, cached: 0 },
        });
        await app.get(AiJobRunnerProvider).instance.waitForIdle();
        expect(mockRunAgent).toHaveBeenCalledTimes(1);
    });
});
