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

import { promises as fs } from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createNestApp } from '../../../src/api/main';
import { SESSION_COOKIE_NAME } from '../../../src/api/auth/session.guard';
import { type WebSessionData } from '../../../src/api/auth/webSession.store';
import { signIn } from '../../fixtures/signIn';
import { config } from '../../../src/config';
import { ReportsService } from '../../../src/api/reports/reports.service';

const REPORTER_ID = 'reports-user';

function webSession(): WebSessionData {
    return {
        discordUserId: REPORTER_ID,
        username: 'tester',
        globalName: 'Tester',
        avatar: null,
        accessToken: 'irrelevant',
        refreshToken: 'irrelevant',
        tokenExpiresAt: Date.now() + 999_999_999,
        guilds: [],
        guildsFetchedAt: Date.now(),
    };
}

function multipartPayload(
    fields: Record<string, string>,
    file?: { name: string; body: Buffer; filename: string; contentType: string },
): { boundary: string; body: Buffer } {
    const boundary = `lestapenna-reports-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const chunks: Buffer[] = [];
    for (const [name, value] of Object.entries(fields)) {
        chunks.push(
            Buffer.from(
                `--${boundary}\r\n` +
                    `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
                    `${value}\r\n`,
            ),
        );
    }
    if (file) {
        chunks.push(
            Buffer.from(
                `--${boundary}\r\n` +
                    `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
                    `Content-Type: ${file.contentType}\r\n\r\n`,
            ),
            file.body,
            Buffer.from(`\r\n--${boundary}--\r\n`),
        );
    } else {
        chunks.push(Buffer.from(`--${boundary}--\r\n`));
    }
    return { boundary, body: Buffer.concat(chunks) };
}

describe('Reports API (pulsante Segnala)', () => {
    let app: NestFastifyApplication;
    let fastify: FastifyInstance;
    let sessionCookie: string;
    let png: Buffer;

    beforeAll(async () => {
        app = await createNestApp();
        await app.init();
        fastify = app.getHttpAdapter().getInstance();

        sessionCookie = 'reports-session-id';
        await signIn(sessionCookie, webSession());

        png = await sharp({
            create: { width: 800, height: 500, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } },
        }).png().toBuffer();
    });

    afterAll(async () => {
        await app.close();
        if (config.reportsStorage.localDirectory.includes('lestapenna_test_reports_')) {
            await fs.rm(config.reportsStorage.localDirectory, { recursive: true, force: true });
        }
    });

    function cookieHeader() {
        return { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` };
    }

    async function postReport(fields: Record<string, string>, file?: { body: Buffer }, extraHeaders: Record<string, string> = {}) {
        const multipart = multipartPayload(
            fields,
            file ? { name: 'screenshot', body: file.body, filename: 'shot.png', contentType: 'image/png' } : undefined,
        );
        return fastify.inject({
            method: 'POST',
            url: '/api/v1/reports',
            headers: {
                ...cookieHeader(),
                'content-type': `multipart/form-data; boundary=${multipart.boundary}`,
                ...extraHeaders,
            },
            payload: multipart.body,
        });
    }

    async function readReport(id: string): Promise<Record<string, unknown> | null> {
        const buf = await new ReportsService()['storage'].readBuffer(`reports/${id}.json`);
        return buf ? JSON.parse(buf.toString('utf8')) : null;
    }

    it('rejects unauthenticated requests', async () => {
        const res = await fastify.inject({ method: 'POST', url: '/api/v1/reports', payload: Buffer.from('') });
        expect(res.statusCode).toBe(401);
    });

    it('rejects an invalid report type', async () => {
        const res = await postReport({ type: 'NOT_A_TYPE', description: 'broken thing' });
        expect(res.statusCode).toBe(400);
    });

    it('rejects a missing description', async () => {
        const res = await postReport({ type: 'BUG' });
        expect(res.statusCode).toBe(400);
    });

    it('rejects a cross-site origin', async () => {
        const res = await postReport(
            { type: 'BUG', description: 'x' },
            undefined,
            { origin: 'https://attacker.example' },
        );
        expect(res.statusCode).toBe(400);
    });

    it('rejects an oversized screenshot', async () => {
        const oversized = Buffer.alloc(6 * 1024 * 1024, 0x80);
        const res = await postReport({ type: 'BUG', description: 'big shot' }, { body: oversized });
        expect(res.statusCode).toBe(400);
    });

    it('creates a report without a screenshot, persists agent-shaped JSON and updates the index', async () => {
        const res = await postReport({
            type: 'UI',
            severity: 'high',
            description: 'Sidebar overlaps the header on narrow viewports.',
            steps: '1. open the app at 360px width',
            url: '/app/guilds/g1/campaigns/2/overview',
            locale: 'it',
            theme: 'dark',
            viewportWidth: '360',
            viewportHeight: '640',
            userAgent: 'Mozilla/5.0 (Test)',
            campaignId: '2',
            guildId: 'g1',
            appVersion: 'dev-build-1',
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.payload);
        expect(body).toMatchObject({ status: 'open', number: expect.any(Number) });
        expect(body.id).toMatch(/^\d{6}$/);

        const stored = await readReport(body.id);
        expect(stored).toMatchObject({
            id: body.id,
            status: 'open',
            type: 'UI',
            severity: 'high',
            screenshot: null,
            agentAnalysis: null,
            resolution: null,
        });
        expect(stored!.reporter).toMatchObject({ discordId: REPORTER_ID, globalName: 'Tester' });
        const context = stored!.context as Record<string, unknown>;
        expect(context).toMatchObject({
            origin: config.reportsStorage.origin,
            url: '/app/guilds/g1/campaigns/2/overview',
            campaignId: 2,
            guildId: 'g1',
            locale: 'it',
            theme: 'dark',
        });
        expect(context.viewport).toEqual({ width: 360, height: 640 });
        const history = stored!.statusHistory as Array<{ status: string }>;
        expect(history[0]).toMatchObject({ status: 'open', by: 'user' });
        expect((stored!.title as string).length).toBeLessThanOrEqual(80);
    });

    it('creates a report with a screenshot, transcodes it to WebP and writes thumbnail objects', async () => {
        const res = await postReport(
            { type: 'BUG', description: 'Crash when opening the quest detail.' },
            { body: png },
        );
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.payload);

        const stored = await readReport(body.id);
        expect(stored!.screenshot).toMatchObject({ hasThumbnail: true });
        const screenshot = stored!.screenshot as { objectKey: string; thumbnailKey: string };
        const storage = new ReportsService()['storage'];
        const display = await storage.readBuffer(screenshot.objectKey);
        const thumb = await storage.readBuffer(screenshot.thumbnailKey);
        expect(display).not.toBeNull();
        expect(thumb).not.toBeNull();
        expect(display!.subarray(0, 4).toString('ascii')).toBe('RIFF');
        expect(display!.subarray(8, 12).toString('ascii')).toBe('WEBP');
    });

    it('assigns progressive numbers across submissions and keeps the index sorted', async () => {
        const first = await postReport({ type: 'OTHER', description: 'first sequential' });
        const second = await postReport({ type: 'OTHER', description: 'second sequential' });
        expect(JSON.parse(first.payload).number).toBeLessThan(JSON.parse(second.payload).number);

        const indexBuf = await new ReportsService()['storage'].readBuffer('reports/index.json');
        const index = JSON.parse(indexBuf!.toString('utf8'));
        const numbers = index.reports.map((r: { number: number }) => r.number);
        expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    });

    it('regenerates the index from per-report JSONs via refreshIndex', async () => {
        const service = new ReportsService();
        // Simulate the agent closing a report by editing its JSON in place.
        const first = await readReport('000001');
        if (first) {
            first.status = 'resolved';
            first.resolution = 'Fixed in commit abc';
            (first.statusHistory as Array<{ status: string; at: number; by: string; note: string }>).push({
                status: 'resolved',
                at: Date.now(),
                by: 'agent',
                note: 'agent closed',
            });
            await service['storage'].putJson('reports/000001.json', Buffer.from(JSON.stringify(first, null, 2), 'utf8'));
        }
        await service.refreshIndex();
        const indexBuf = await service['storage'].readBuffer('reports/index.json');
        const index = JSON.parse(indexBuf!.toString('utf8'));
        const entry = index.reports.find((r: { id: string }) => r.id === '000001');
        expect(entry.status).toBe('resolved');
    });
});