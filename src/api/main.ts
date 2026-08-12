import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
    FastifyAdapter,
    NestFastifyApplication,
} from '@nestjs/platform-fastify';
import fastifyMultipart from '@fastify/multipart';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { SESSION_COOKIE_NAME } from './auth/session.guard';
import { AppModule } from './app.module';
import { logger } from '../utils/logger';

const log = logger('NestJS');

/**
 * The OpenAPI document is the source of truth for the SPA's types:
 * `npm run openapi:generate` writes it to web/openapi.json, and web's
 * `npm run api:types` turns it into web/src/api/schema.d.ts. Both artefacts
 * are committed because Dockerfile.caddy builds web/ in an isolated stage
 * with no backend source to regenerate them from.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
    const config = new DocumentBuilder()
        .setTitle('Lestapenna API')
        .setDescription('Read-only campaign data for the authenticated web app.')
        .setVersion('v1')
        .addCookieAuth(SESSION_COOKIE_NAME)
        .build();
    return SwaggerModule.createDocument(app, config);
}

export async function createNestApp(): Promise<NestFastifyApplication> {
    const app = await NestFactory.create<NestFastifyApplication>(
        AppModule,
        new FastifyAdapter({
            // Media files are streamed and capped at 5 MiB by multipart below.
            bodyLimit: 6 * 1024 * 1024,
        }),
        { logger: false }, // Use project's custom structured logger
    );

    // Fastify's stock application/json parser rejects an empty body with
    // FST_ERR_CTP_EMPTY_JSON_BODY, but several endpoints are POSTs with no
    // payload (and browsers still send Content-Type: application/json for
    // them). Treat an empty body as `undefined` so Nest's ValidationPipe sees
    // a missing DTO rather than a parse error.
    //
    // Goes through Nest's own `useBodyParser`, not Fastify's
    // `addContentTypeParser`: it flags the parser as registered, so `app.init()`
    // does not try to install its own on top and fail with "already present".
    app.useBodyParser(
        'application/json',
        {},
        (_req: unknown, body: Buffer, done: (err: Error | null, result?: unknown) => void) => {
            if (body.length === 0) {
                done(null, undefined);
                return;
            }
            try {
                done(null, JSON.parse(body.toString('utf-8')));
            } catch (err) {
                // Without an explicit status a parse failure surfaces as a 500;
                // a malformed body is the client's error, not ours.
                (err as Error & { statusCode?: number }).statusCode = 400;
                done(err as Error);
            }
        },
    );

    await app.register(fastifyMultipart, {
        limits: {
            files: 1,
            fileSize: 5 * 1024 * 1024,
            // Report submissions carry more context fields (url, locale, theme,
            // viewport, userAgent, campaignId, …) than entity media; entity media
            // still rejects unexpected fields itself, so raising the cap is safe.
            fields: 16,
            parts: 20,
        },
    });

    // Caddy proxies everything that is not /app/* to Nest, so a docs route
    // would be publicly reachable in production. Dev convenience only.
    if (process.env.NODE_ENV !== 'production') {
        SwaggerModule.setup('api/v1/docs', app, buildOpenApiDocument(app));
    }

    return app;
}

export async function startApiServer(): Promise<NestFastifyApplication> {
    const app = await createNestApp();
    const port = Number.parseInt(process.env.PORT ?? '3000', 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`Invalid PORT: ${process.env.PORT}`);
    }
    await app.listen(port, '0.0.0.0');
    log.info(`HTTP server listening on port ${port}`);
    return app;
}
