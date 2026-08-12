/**
 * Reporter Config
 */

import * as nodemailer from 'nodemailer';
import OpenAI from 'openai';
import { config } from '../config';
import { routeFor } from '../bard/config';

// Configurazione SMTP per Porkbun
export const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: true,
    auth: {
        user: config.smtp.user,
        pass: config.smtp.pass
    }
});

/**
 * AI route for the technical report.
 *
 * The mail reaches the operator, but **the guild that started the session pays
 * for it**: there is no instance-level scope to charge it to. So it uses the
 * ambient scope, like every other phase — and all of its callers (end of
 * session, `$rebuild`, `$recover`, `$publish`, startup recovery) are already
 * inside one.
 *
 * This used to host a second provider-resolution chain, a diverging copy of the
 * one in `bard/config.ts` — and it did not handle `anthropic`, so with the chat
 * phase on Claude it built an OpenAI client with the wrong key. It now leans on
 * the resolver, and lazily: building the client at import time meant reading
 * the keys when the module loaded.
 */
export async function getReporterRoute() {
    return routeFor('chat');
}
