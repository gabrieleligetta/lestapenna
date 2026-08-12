import { createNestApp } from '../../../src/api/main';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyInstance } from 'fastify';

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

describe('Landing Pages', () => {
    it('should serve English landing page at /', async () => {
        const response = await fastify.inject({ method: 'GET', url: '/' });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.payload).toContain('Lestapenna');
        expect(response.payload).toContain('lang="en"');
    });

    it('should serve Italian landing page at /it/', async () => {
        const response = await fastify.inject({ method: 'GET', url: '/it/' });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.payload).toContain('lang="it"');
    });

    it.each([
        ['English', '/', 'lang="en"'],
        ['Italian', '/it/', 'lang="it"'],
        ['French', '/fr/', 'lang="fr"'],
        ['Spanish', '/es/', 'lang="es"'],
        ['German', '/de/', 'lang="de"'],
        ['Brazilian Portuguese', '/pt-BR/', 'lang="pt-BR"'],
    ])('states plainly on the %s landing that nothing is sold', async (_name, url, lang) => {
        const response = await fastify.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(200);
        expect(response.payload).toContain(lang);

        // The test is the inverse of what it was: it now defends the ABSENCE of
        // prices. It is the product's central promise — «we do not receive a
        // penny» — and a landing page that put a price list back would contradict it.
        for (const price of ['4,99', '4.99', '9,99', '9.99', '19,99', '19.99', '49,99', '49.99']) {
            expect(response.payload).not.toContain(price);
        }
        for (const plan of ['Starter', 'Chronicle', 'Legendary']) {
            expect(response.payload).not.toContain(plan);
        }
        expect(response.payload).not.toContain('AggregateOffer');
        expect(response.payload).not.toMatch(/Stripe/i);

        // And the presence of what takes their place.
        expect(response.payload).toContain('"price": "0"');
        expect(response.payload).toContain('"isAccessibleForFree": true');
        expect(response.payload).toContain('agpl-3.0');
        expect(response.payload).toContain('github.com/gabrieleligetta/lestapenna');
        expect(response.payload).toContain('github.com/sponsors/gabrieleligetta');
    });

    it('serves the licence page, because AGPL is a promise and not a footnote', async () => {
        const response = await fastify.inject({ method: 'GET', url: '/license' });
        expect(response.statusCode).toBe(200);
        expect(response.payload).toContain('Affero');
        // The distinction that matters to the reader: the software is free, the
        // material of their campaign stays theirs.
        expect(response.payload).toMatch(/campaign content is not covered/i);
    });

    it('serves the cookie page, and it says there is nothing to consent to', async () => {
        const response = await fastify.inject({ method: 'GET', url: '/cookies' });
        expect(response.statusCode).toBe(200);
        expect(response.payload).toMatch(/lp_session/);
        expect(response.payload).toMatch(/no analytics/i);
    });

    it('names every sub-processor in the privacy policy, in full', async () => {
        // «We do not sell data» is worth little without the list of who touches it.
        const response = await fastify.inject({ method: 'GET', url: '/privacy' });
        for (const processor of ['Discord', 'Oracle Cloud', 'Porkbun']) {
            expect(response.payload).toContain(processor);
        }
        expect(response.payload).toMatch(/do not sell personal data/i);
        expect(response.payload).not.toMatch(/Stripe/);
    });

    it('the terms say the service is free and that keys are the user\'s', async () => {
        const response = await fastify.inject({ method: 'GET', url: '/terms' });
        expect(response.payload).toMatch(/service is free and we receive no payment/i);
        expect(response.payload).toMatch(/bring your own AI keys/i);
        expect(response.payload).toContain('Affero');
    });

    it('serves the notice page without a login, because a rights holder has no account', async () => {
        const response = await fastify.inject({ method: 'GET', url: '/notice' });
        expect(response.statusCode).toBe(200);
        // The four things a report needs to be actionable rather than merely received.
        expect(response.payload).toMatch(/reasoned explanation|why the material is unlawful/i);
        expect(response.payload).toMatch(/page\s+address/i);
        expect(response.payload).toMatch(/name and an email address/i);
        expect(response.payload).toMatch(/accurate and complete/i);
        // An address that is not there is a mechanism that does not exist.
        expect(response.payload).toContain('info@lestapenna.quest');
    });

    it('the terms cover pictures people upload, and how to get one taken down', async () => {
        const response = await fastify.inject({ method: 'GET', url: '/terms' });
        // The warranty the whole arrangement rests on.
        expect(response.payload).toMatch(/right to upload/i);
        // Saying uploads are not screened is what makes the hosting exemption
        // honest rather than convenient, so it has to survive any later edit.
        expect(response.payload).toMatch(/no\s+prior\s+screening/i);
        expect(response.payload).toMatch(/2022\/2065/);
        expect(response.payload).toContain('/notice');
    });

    it('the privacy policy names uploaded pictures and says when they go', async () => {
        const response = await fastify.inject({ method: 'GET', url: '/privacy' });
        expect(response.payload).toMatch(/Pictures you upload/i);
        // Claimed in the policy and made true by dataErasure: the stored file
        // goes, not merely the row pointing at it.
        expect(response.payload).toMatch(/deletes the stored\s+file itself/i);
    });

    it('should serve privacy policy at /privacy', async () => {
        const response = await fastify.inject({
            method: 'GET',
            url: '/privacy',
        });
        expect(response.statusCode).toBe(200);
        expect(response.payload).toContain('Privacy Policy');
    });

    it('should serve terms of service at /terms', async () => {
        const response = await fastify.inject({
            method: 'GET',
            url: '/terms',
        });
        expect(response.statusCode).toBe(200);
        expect(response.payload).toContain('Terms of Service');
        // Searching for the word «subscription» would say nothing: it appears in «there
        // is no subscription». The whole sentence is what counts.
        expect(response.payload).toMatch(/no subscription, no credit, no purchase/i);
        expect(response.payload).not.toMatch(/Stripe|refund/i);
    });

    it('the privacy policy claims no tracking, which is a claim we can verify', async () => {
        const response = await fastify.inject({ method: 'GET', url: '/privacy' });
        expect(response.statusCode).toBe(200);
        expect(response.payload).toMatch(/no analytics/i);
        // No payment data, because there is nothing to pay.
        expect(response.payload).not.toMatch(/payment and refund status/i);
    });

    it('should serve 404 page for unknown routes', async () => {
        const response = await fastify.inject({
            method: 'GET',
            url: '/nonexistent-page',
        });
        expect(response.statusCode).toBe(404);
        expect(response.payload).toContain('404');
    });

    it('should serve robots.txt', async () => {
        const response = await fastify.inject({
            method: 'GET',
            url: '/robots.txt',
        });
        expect(response.statusCode).toBe(200);
        expect(response.payload).toContain('User-agent');
    });

    it('should serve sitemap.xml', async () => {
        const response = await fastify.inject({
            method: 'GET',
            url: '/sitemap.xml',
        });
        expect(response.statusCode).toBe(200);
        expect(response.payload).toContain('urlset');
        expect(response.payload).toContain('https://lestapenna.quest/fr/');
        expect(response.payload).toContain('https://lestapenna.quest/es/');
        expect(response.payload).toContain('https://lestapenna.quest/de/');
        expect(response.payload).toContain('https://lestapenna.quest/pt-BR/');
    });

    it('should serve CSS assets', async () => {
        const response = await fastify.inject({
            method: 'GET',
            url: '/assets/site.css',
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/css');
    });
});
