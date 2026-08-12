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

/** The provider itself is the one thing that must never be reached from a test. */
const mockGenerateImage: any = jest.fn();
jest.mock('../../../src/bard/llm/image', () => ({
    ...jest.requireActual('../../../src/bard/llm/image'),
    generateImage: (...args: unknown[]) => mockGenerateImage(...args),
}));

const mockBuildPortraitPrompt: any = jest.fn();
jest.mock('../../../src/bard/imagePrompt', () => {
    const actual = jest.requireActual('../../../src/bard/imagePrompt');
    return {
        ...actual,
        // Default: stubbed, because most cases here are about money and plumbing.
        // One case deliberately falls through to the real builder — see
        // "reaches the real prompt builder…", which is the seam the first
        // production failure lived in.
        buildPortraitPrompt: (...args: unknown[]) => mockBuildPortraitPrompt(...args),
    };
});

/** The only thing the real prompt builder must not reach in a test. */
const mockGenerateText: any = jest.fn();
jest.mock('../../../src/bard/llm/generate', () => ({
    ...jest.requireActual('../../../src/bard/llm/generate'),
    generateText: (...args: unknown[]) => mockGenerateText(...args),
}));

jest.mock('../../../src/bard/rag/search', () => ({
    ...jest.requireActual('../../../src/bard/rag/search'),
    searchKnowledge: jest.fn().mockResolvedValue([]),
}));

/** Building a real client would need a real key; the route is not what is under test. */
jest.mock('../../../src/bard/config', () => ({
    ...jest.requireActual('../../../src/bard/config'),
    getImageClient: jest.fn().mockResolvedValue({
        client: {},
        model: 'imagen-4.0-generate-001',
        provider: 'gemini',
        creds: { provider: 'gemini', apiKey: null, source: 'tenant', secretKey: 'gemini.apiKey', scope: {} },
        scope: { guildId: 'image-gen-guild' },
    }),
    // The real prompt builder asks for this one to write the brief.
    getMetadataClient: jest.fn().mockResolvedValue({
        client: {},
        model: 'gemini-3-flash-preview',
        provider: 'gemini',
        creds: { provider: 'gemini', apiKey: null, source: 'tenant', secretKey: 'gemini.apiKey', scope: {} },
        scope: { guildId: 'image-gen-guild' },
    }),
}));

import { promises as fs } from 'fs';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createNestApp } from '../../../src/api/main';
import { SESSION_COOKIE_NAME } from '../../../src/api/auth/session.guard';
import { type WebSessionData } from '../../../src/api/auth/webSession.store';
import { signIn } from '../../fixtures/signIn';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { npcRepository } from '../../../src/db/repositories/NpcRepository';
import { entityMediaRepository } from '../../../src/db/repositories/EntityMediaRepository';
import { ImageRefusedError } from '../../../src/bard/llm/image';
import { config } from '../../../src/config';
import { db } from '../../../src/db';
import { AiJobRunnerProvider } from '../../../src/api/aiJobs/aiJobRunner.provider';

const GUILD_ID = 'image-gen-guild';
const MANAGER_ID = 'image-gen-manager';
const READER_ID = 'image-gen-reader';

function webSession(discordUserId: string, canManage: boolean): WebSessionData {
    return {
        discordUserId,
        username: discordUserId,
        globalName: null,
        avatar: null,
        accessToken: 'irrelevant',
        refreshToken: 'irrelevant',
        tokenExpiresAt: Date.now() + 999_999_999,
        guilds: [{ id: GUILD_ID, name: 'Image Guild', icon: null, canManage }],
        guildsFetchedAt: Date.now(),
    };
}

/**
 * Generating an entity's portrait, and paying for it.
 *
 * The cases that matter most are not the happy path but the money: what gets
 * written to the ledger, and that an unknown rate stays unknown instead of
 * quietly becoming free on the most expensive action in the product.
 */
describe('Entity image generation', () => {
    let app: NestFastifyApplication;
    let fastify: FastifyInstance;
    let campaignId: number;
    let managerCookie: string;
    let readerCookie: string;
    let npcShortId: string;
    let drawn: Buffer;

    beforeAll(async () => {
        app = await createNestApp();
        await app.init();
        fastify = app.getHttpAdapter().getInstance();

        campaignId = campaignRepository.createCampaign(GUILD_ID, 'Image Generation Campaign');
        npcRepository.updateNpcEntry(campaignId, `Prince ${process.pid}`, 'Heir to a cold throne');
        npcShortId = (db.prepare(
            'SELECT short_id FROM npc_dossier WHERE campaign_id = ?',
        ).get(campaignId) as { short_id: string }).short_id;

        managerCookie = 'image-gen-manager-session';
        readerCookie = 'image-gen-reader-session';
        await signIn(managerCookie, webSession(MANAGER_ID, true));
        await signIn(readerCookie, webSession(READER_ID, false));

        drawn = await sharp({
            create: { width: 768, height: 1024, channels: 4, background: { r: 20, g: 30, b: 60, alpha: 1 } },
        }).png().toBuffer();
    });

    afterAll(async () => {
        await app.close();
        if (config.mediaStorage.localDirectory.includes('lestapenna_test_media_')) {
            await fs.rm(config.mediaStorage.localDirectory, { recursive: true, force: true });
        }
    });

    beforeEach(() => {
        jest.clearAllMocks();
        db.prepare('DELETE FROM entity_media WHERE campaign_id = ?').run(campaignId);
        db.prepare('DELETE FROM ai_usage_log WHERE campaign_id = ?').run(campaignId);
        db.prepare('DELETE FROM ai_job WHERE campaign_id = ?').run(campaignId);

        mockBuildPortraitPrompt.mockResolvedValue({
            prompt: 'A pale young man in a fur-lined cloak.',
            sources: ['sheet', 'rag'],
            shape: 'portrait',
            usedTextCall: true,
            textUsage: { input: 1200, output: 150, cached: 0 },
        });
        mockGenerateImage.mockResolvedValue({
            bytes: drawn,
            mimeType: 'image/png',
            provider: 'gemini',
            model: 'imagen-4.0-generate-001',
            usage: { input: 0, output: 0, cached: 0 },
            imageCount: 1,
            latencyMs: 1200,
        });
    });

    function cookieHeader(cookie: string) {
        return { cookie: `${SESSION_COOKIE_NAME}=${cookie}` };
    }

    const base = () => `/api/v1/campaigns/${campaignId}/npc/${npcShortId}/image`;

    function generate(body: unknown, cookie = managerCookie) {
        return fastify.inject({
            method: 'POST',
            url: `${base()}/generate`,
            headers: { ...cookieHeader(cookie), 'content-type': 'application/json' },
            payload: body as never,
        });
    }

    /**
     * Asks for a picture and lets the work finish, then reads the job back.
     *
     * Two separate requests on purpose: the second one is the same request a
     * browser makes after being reconnected, reloaded or reopened tomorrow —
     * which is the property this whole feature exists to have.
     */
    async function generateAndRun(body: unknown, cookie = managerCookie) {
        const accepted = await generate(body, cookie);
        if (accepted.statusCode !== 202) return { accepted, job: null as any };
        await app.get(AiJobRunnerProvider).instance.waitForIdle();
        const read = await fastify.inject({
            method: 'GET',
            url: `/api/v1/campaigns/${campaignId}/ai-jobs/${accepted.json().job_id}`,
            headers: cookieHeader(cookie),
        });
        return { accepted, job: read.json() };
    }

    function commit(jobId: string, cookie = managerCookie) {
        return fastify.inject({
            method: 'POST',
            url: `${base()}/generate/${encodeURIComponent(jobId)}/commit`,
            headers: cookieHeader(cookie),
        });
    }

    it('quotes both calls before spending anything', async () => {
        const auto = await fastify.inject({
            method: 'GET',
            url: `${base()}/generate/estimate?mode=auto`,
            headers: cookieHeader(managerCookie),
        });
        expect(auto.statusCode).toBe(200);
        const autoBody = auto.json();
        // In auto a text model writes the brief before the image model draws it:
        // quoting only the picture would understate the click.
        expect(autoBody.text_model).not.toBeNull();
        expect(autoBody.billable).toBe(true);
        expect(autoBody.estimated_cost_usd).toBeGreaterThan(0);

        const written = await fastify.inject({
            method: 'GET',
            url: `${base()}/generate/estimate?mode=prompt`,
            headers: cookieHeader(managerCookie),
        });
        // Nobody is paid to paraphrase words the person already wrote.
        expect(written.json().text_model).toBeNull();
        expect(written.json().estimated_cost_usd).toBeLessThan(autoBody.estimated_cost_usd);
    });

    it('refuses a reader, in the same way an upload does', async () => {
        const response = await generate({ mode: 'auto' }, readerCookie);
        expect(response.statusCode).toBe(403);
        expect(mockGenerateImage).not.toHaveBeenCalled();
    });

    it('refuses a cross-site request before calling the provider', async () => {
        const response = await fastify.inject({
            method: 'POST',
            url: `${base()}/generate`,
            headers: {
                ...cookieHeader(managerCookie),
                'content-type': 'application/json',
                origin: 'https://attacker.example',
            },
            payload: { mode: 'auto' } as never,
        });
        expect(response.statusCode).toBe(400);
        expect(mockGenerateImage).not.toHaveBeenCalled();
    });

    it('rejects a mode it does not know, and a prompt mode with no prompt', async () => {
        expect((await generate({ mode: 'interpretive-dance' })).statusCode).toBe(400);
        expect((await generate({ mode: 'prompt' })).statusCode).toBe(400);
        expect((await generate({ mode: 'prompt', prompt: '   ' })).statusCode).toBe(400);
        expect(mockGenerateImage).not.toHaveBeenCalled();
    });

    it('survives the request that asked for it, and commits on a later one', async () => {
        const { accepted, job } = await generateAndRun({ mode: 'auto' });

        // The answer is a receipt, not a picture: the drawing outlives this call.
        expect(accepted.statusCode).toBe(202);
        expect(accepted.json().status).toBe('queued');
        expect(job.status).toBe('awaiting_review');
        // Nothing is on the sheet yet: the picture is being offered, not applied.
        const stored = db.prepare(
            'SELECT COUNT(*) AS n FROM entity_media WHERE campaign_id = ?',
        ).get(campaignId) as { n: number };
        expect(stored.n).toBe(0);

        const preview = await fastify.inject({
            method: 'GET',
            url: `${base()}/generate/${encodeURIComponent(job.id)}/preview`,
            headers: cookieHeader(managerCookie),
        });
        expect(preview.statusCode).toBe(200);
        expect(preview.rawPayload.length).toBeGreaterThan(0);

        const committed = await commit(job.id);
        expect(committed.statusCode).toBe(201);
        expect(committed.json().source).toBe('ai');
    });

    it('is still there after the process that drew it is gone', async () => {
        const { job } = await generateAndRun({ mode: 'auto' });

        // A whole new application, as after a redeploy. The old in-memory draft
        // died with its process; this one is a row and two objects.
        const second = await createNestApp();
        await second.init();
        try {
            const read = await second.getHttpAdapter().getInstance().inject({
                method: 'GET',
                url: `/api/v1/campaigns/${campaignId}/ai-jobs/${job.id}`,
                headers: cookieHeader(managerCookie),
            });
            expect(read.json().status).toBe('awaiting_review');

            const committed = await second.getHttpAdapter().getInstance().inject({
                method: 'POST',
                url: `${base()}/generate/${encodeURIComponent(job.id)}/commit`,
                headers: cookieHeader(managerCookie),
            });
            expect(committed.statusCode).toBe(201);
        } finally {
            await second.close();
        }
    });

    it('keeps the mode and the person\'s own words, so the request can be run again', async () => {
        const { job } = await generateAndRun({ mode: 'mixed', prompt: 'make him much older' });

        const committed = await commit(job.id);
        const image = committed.json();
        expect(image.generationMode).toBe('mixed');
        // The person's words, not the expanded brief that reached the provider.
        expect(image.generationPrompt).toBe('make him much older');
        expect(image.generationPrompt).not.toContain('fur-lined cloak');
    });

    it('writes what was spent to the ledger, one row per model', async () => {
        const { job } = await generateAndRun({ mode: 'auto' });
        expect(job.status).toBe('awaiting_review');

        const rows = db.prepare(
            'SELECT phase, model, cost_usd, pricing_source FROM ai_usage_log WHERE campaign_id = ? ORDER BY phase',
        ).all(campaignId) as Array<{ phase: string; model: string; cost_usd: number; pricing_source: string }>;

        // Two calls at two rates: merging them would make either unattributable.
        expect(rows.map(r => r.phase)).toEqual(['image', 'image-prompt']);
        expect(rows[0].model).toBe('imagen-4.0-generate-001');
        expect(rows[0].cost_usd).toBeCloseTo(0.04, 4);
        expect(rows[0].pricing_source).toBe('builtin');
    });

    it('says the price is unknown rather than free when it does not know it', async () => {
        mockGenerateImage.mockResolvedValue({
            bytes: drawn,
            mimeType: 'image/png',
            provider: 'gemini',
            model: 'some-model-released-last-week',
            usage: { input: 0, output: 0, cached: 0 },
            imageCount: 1,
            latencyMs: 900,
        });

        const { job } = await generateAndRun({ mode: 'prompt', prompt: 'a knight' });

        expect(job.cost_usd).toBeNull();
        expect(job.pricing_available).toBe(false);
        // The provider still answered, and the register says so: without this
        // the only paid call that leaves no ledger row would leave no trace at all.
        expect(job.charged).toBe(true);
        // The picture's rate is unknown, so no row claims a spend for it — a
        // zero there would read as free. The brief's rate is perfectly known,
        // and that half is still recorded: half a ledger beats none.
        const rows = db.prepare(
            'SELECT phase FROM ai_usage_log WHERE campaign_id = ?',
        ).all(campaignId) as Array<{ phase: string }>;
        expect(rows.map(r => r.phase)).toEqual(['image-prompt']);
    });

    it('reports a provider refusal as something to change, not a broken key', async () => {
        mockGenerateImage.mockRejectedValue(new ImageRefusedError('blocked by the safety filter'));

        const { job } = await generateAndRun({ mode: 'prompt', prompt: 'something disallowed' });

        expect(job.status).toBe('failed');
        expect(job.error_kind).toBe('refused');
        expect(job.error_message).toContain('refused');
    });

    it('reports an overloaded provider as an upstream failure, not as a bug of ours', async () => {
        // Verbatim from production: this is what a table saw as «internal
        // server error», and it was Google having a busy minute.
        const overloaded: any = new Error(JSON.stringify({
            error: {
                code: 503,
                message: 'This model is currently experiencing high demand. Please try again later.',
                status: 'UNAVAILABLE',
            },
        }));
        overloaded.status = 503;
        mockGenerateImage.mockRejectedValue(overloaded);

        const { job } = await generateAndRun({ mode: 'prompt', prompt: 'a knight' });

        // Classified as the provider's bad minute, not as a bug of ours: the
        // difference between «try again» and «something is broken here».
        expect(job.status).toBe('failed');
        expect(job.error_kind).toBe('provider');
        // Nothing was drawn, so nothing may claim a spend for a picture.
        const rows = db.prepare(
            "SELECT phase FROM ai_usage_log WHERE campaign_id = ? AND phase = 'image'",
        ).all(campaignId);
        expect(rows).toEqual([]);
        expect(job.charged).toBe(false);
    });

    it('closes a decision once it is taken, whichever way it went', async () => {
        const { job } = await generateAndRun({ mode: 'auto' });

        expect((await commit(job.id)).statusCode).toBe(201);
        // A second acceptance would file the same picture twice; the decision is
        // already recorded, so there is nothing left to accept.
        expect((await commit(job.id)).statusCode).toBe(404);

        const { job: other } = await generateAndRun({ mode: 'auto' });
        const discarded = await fastify.inject({
            method: 'DELETE',
            url: `${base()}/generate/${encodeURIComponent(other.id)}`,
            headers: cookieHeader(managerCookie),
        });
        expect(discarded.statusCode).toBe(204);
        expect((await commit(other.id)).statusCode).toBe(404);
    });

    it('lets a master decide on somebody else\'s picture, and a bystander not', async () => {
        // The reader is not a member, so they cannot even see it.
        const { job } = await generateAndRun({ mode: 'auto' });
        expect((await commit(job.id, readerCookie)).statusCode).toBe(403);

        // The manager here is a master of the table: somebody has to be able to
        // close a decision the person who asked for it never came back for.
        expect((await commit(job.id, managerCookie)).statusCode).toBe(201);
    });

    /**
     * The regression that reached production.
     *
     * `resolveEntity` returns the internal row id as `entityKey`, while the
     * prompt builder looks entities up by **short id**. Passing the first where
     * the second was expected found nothing and threw, and the request came back
     * as a 500 with nothing in the logs. Neither existing test caught it: the
     * unit test mocked the repositories to answer whatever they were asked, and
     * every case here mocked the builder away entirely. So this one runs the
     * real path, with only the text model stubbed.
     */
    it('reaches the real prompt builder with an id it can actually resolve', async () => {
        const { buildPortraitPrompt } = jest.requireActual('../../../src/bard/imagePrompt');
        mockBuildPortraitPrompt.mockImplementation((request: unknown) => buildPortraitPrompt(request));
        mockGenerateText.mockResolvedValue({
            content: 'A pale young man in a fur-lined cloak.',
            usage: { input: 400, output: 90, cached: 0 },
        });

        const { job } = await generateAndRun({ mode: 'auto' });

        expect(job.status).toBe('awaiting_review');
        // The brief was written from the NPC the URL names, not from nothing.
        expect(mockGenerateText.mock.calls[0][0].prompt).toContain('Heir to a cold throne');
    });

    /**
     * A model the provider has withdrawn is the user's to fix, not ours.
     *
     * Google retired the whole Imagen family for new projects, so a table on a
     * stale default gets a 404 — and answering 500 to that sent someone to read
     * server logs about a line they can change in their own settings.
     */
    it('reports a rejected model as a request problem, with the provider\'s words', async () => {
        mockGenerateImage.mockRejectedValue(Object.assign(
            new Error('This model models/imagen-4.0-fast-generate-001 is no longer available to new users.'),
            { status: 404 },
        ));

        const { job } = await generateAndRun({ mode: 'auto' });

        expect(job.status).toBe('failed');
        expect(job.error_message).toContain('no longer available');
    });

    it('does not let one entity be generated twice at once', async () => {
        let release: (value: unknown) => void = () => {};
        mockGenerateImage.mockImplementation(() => new Promise((resolve) => {
            release = resolve;
        }));

        const first = await generate({ mode: 'auto' });
        expect(first.statusCode).toBe(202);
        // The lock is now the database, so it holds from the moment the row
        // exists — before the provider is reached, and across a restart.
        const second = await generate({ mode: 'auto' });
        expect(second.statusCode).toBe(409);

        release({
            bytes: drawn,
            mimeType: 'image/png',
            provider: 'gemini',
            model: 'imagen-4.0-generate-001',
            usage: { input: 0, output: 0, cached: 0 },
            imageCount: 1,
            latencyMs: 10,
        });
        await app.get(AiJobRunnerProvider).instance.waitForIdle();
        // One request, one call: the refused second one never reached a provider.
        expect(mockGenerateImage).toHaveBeenCalledTimes(1);
    });
});
