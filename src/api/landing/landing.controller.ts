import { Controller, Get, Res, All, Req } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { join } from 'path';
import { readFile } from 'fs/promises';

const PUBLIC_DIR = join(__dirname, '..', '..', '..', 'public');

async function sendHtml(reply: FastifyReply, filePath: string, status = 200) {
    const content = await readFile(join(PUBLIC_DIR, filePath), 'utf-8');
    return reply.status(status).type('text/html; charset=utf-8').send(content);
}

@Controller()
export class LandingController {
    // Rewrite /privacy to /legal/privacy.html
    @Get('privacy')
    getPrivacy(@Res() reply: FastifyReply) {
        return sendHtml(reply, 'legal/privacy.html');
    }

    // Rewrite /terms to /legal/terms.html
    @Get('terms')
    getTerms(@Res() reply: FastifyReply) {
        return sendHtml(reply, 'legal/terms.html');
    }

    // Rewrite /license to /legal/license.html — the AGPL is not a footer
    // detail: it is what keeps the project free for whoever comes next.
    @Get('license')
    getLicense(@Res() reply: FastifyReply) {
        return sendHtml(reply, 'legal/license.html');
    }

    // Rewrite /cookies to /legal/cookies.html
    @Get('cookies')
    getCookies(@Res() reply: FastifyReply) {
        return sendHtml(reply, 'legal/cookies.html');
    }

    // Rewrite /notice to /legal/notice.html — the notice-and-action mechanism a
    // hosting service owes under DSA Article 16. It has to be reachable without
    // an account: whoever reports an infringing picture is, by definition, not a
    // member of the table that uploaded it.
    @Get('notice')
    getNotice(@Res() reply: FastifyReply) {
        return sendHtml(reply, 'legal/notice.html');
    }

    // Catch-all 404 for non-API, non-static routes.
    // ServeStaticModule handles existing static files first (Fastify plugins
    // run before route handlers), so this only fires for truly unmatched paths.
    @All('*')
    notFound(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
        // Return JSON 404 for API routes
        if (
            req.url.startsWith('/api/') ||
            req.url === '/health' ||
            req.url.startsWith('/webhooks/')
        ) {
            return reply.status(404).send({ error: 'Not found' });
        }
        // Return custom HTML 404 page for browser requests
        return sendHtml(reply, '404.html', 404);
    }
}
