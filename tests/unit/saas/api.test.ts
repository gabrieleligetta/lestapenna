import { createNestApp } from '../../../src/api/main';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyInstance } from 'fastify';

jest.mock('../../../src/services/operationalHealth', () => ({
    getOperationalHealth: jest.fn().mockResolvedValue({
        status: 'ok',
        role: 'all',
        timestamp: new Date().toISOString(),
        criticalReasons: [],
    }),
}));

let app: NestFastifyApplication;
let fastify: FastifyInstance;

beforeAll(async () => {
    app = await createNestApp();
    await app.init();
    fastify = app.getHttpAdapter().getInstance();
});

afterAll(async () => {
    await app.close();
});

describe('API Server', () => {
    describe('GET /health', () => {
        it('should return 200 with status ok', async () => {
            const response = await fastify.inject({
                method: 'GET',
                url: '/health',
            });
            expect(response.statusCode).toBe(200);
            const body = JSON.parse(response.payload);
            expect(body.status).toBe('ok');
            expect(body.timestamp).toBeDefined();
        });
    });

    describe('JSON body parser', () => {
        // Fastify's stock parser answers FST_ERR_CTP_EMPTY_JSON_BODY (400) to an
        // empty body, which would break every POST that carries no payload. The
        // custom parser in main.ts turns it into `undefined` instead — this test
        // is the guard, because the failure mode is a 400 on unrelated routes.
        it('accepts an empty application/json body instead of failing to parse it', async () => {
            const response = await fastify.inject({
                method: 'POST',
                url: '/api/v1/definitely-not-a-route',
                payload: '',
                headers: { 'content-type': 'application/json' },
            });
            expect(response.statusCode).toBe(404);
        });

        it('still rejects malformed JSON', async () => {
            const response = await fastify.inject({
                method: 'POST',
                url: '/api/v1/definitely-not-a-route',
                payload: '{ not json',
                headers: { 'content-type': 'application/json' },
            });
            expect(response.statusCode).toBe(400);
        });
    });

    describe('GET /api/v1/app-info', () => {
        // The support bar sits on the login page too, so this is the one /api/v1
        // route that has to answer with no cookie at all. If it ever ends up
        // behind SessionGuard, the bar goes blank for everyone logged out.
        it('answers without a session', async () => {
            const response = await fastify.inject({
                method: 'GET',
                url: '/api/v1/app-info',
            });

            expect(response.statusCode).toBe(200);
            const body = JSON.parse(response.payload);
            expect(body.license).toBe('AGPL-3.0');
            expect(typeof body.repo_url).toBe('string');
            expect(Array.isArray(body.donations)).toBe(true);
            for (const channel of body.donations) {
                expect(['kofi', 'github']).toContain(channel.platform);
                expect(typeof channel.url).toBe('string');
                expect(typeof channel.active).toBe('boolean');
            }
        });
    });

    describe('Unknown routes', () => {
        it('should return 404 for unknown paths', async () => {
            const response = await fastify.inject({
                method: 'GET',
                url: '/unknown',
            });
            expect(response.statusCode).toBe(404);
        });
    });
});
