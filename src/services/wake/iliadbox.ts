import * as https from 'https';
import * as crypto from 'crypto';
import axios from 'axios';
import type { WakeConfig, WakeMethod } from './types';

/**
 * Iliadbox (and Freebox): wake-up through the router's API.
 *
 * One of the possible implementations, not *the* way of switching a PC on. It is
 * useful when the magic packet does not reach the LAN — here the router itself
 * emits it, so the "who forwards it" problem disappears.
 *
 * It requires the router's administration password, which lives in the vault
 * like any other credential.
 */

interface CookieJar { [name: string]: string }

// The router presents a certificate for its own internal domain: from a private
// network that is normal and there is no way to verify it. It is accepted here and
// nowhere else in the project.
const iliadboxAgent = new https.Agent({ rejectUnauthorized: false });

function updateCookieJar(cookieJar: CookieJar, setCookie?: string[]): void {
    if (!setCookie) return;
    for (const cookie of setCookie) {
        const firstPart = cookie.split(';', 1)[0];
        const separatorIndex = firstPart.indexOf('=');
        if (separatorIndex > 0) {
            cookieJar[firstPart.slice(0, separatorIndex)] = firstPart.slice(separatorIndex + 1);
        }
    }
}

function cookieHeader(cookieJar: CookieJar): string | undefined {
    const cookies = Object.entries(cookieJar).map(([name, value]) => `${name}=${value}`);
    return cookies.length ? cookies.join('; ') : undefined;
}

/**
 * The router sends JS fragments to be evaluated during login (an anti-bot
 * challenge, with several obfuscation schemes observed over time).
 *
 * `eval()` on remote input is normally unacceptable. Here the source is the
 * table's home router, reachable only from its private network: anyone able to
 * alter that response is already inside the network. It is still the reason
 * this method is opt-in and not the default.
 */
function getIliadboxChallenge(challengeTable: string[]): string {
    let challenge = '';
    for (const expression of challengeTable) challenge += String(eval(expression));
    return challenge;
}

async function sendIliadboxWakeRequest(
    iliadboxUrl: string,
    password: string,
    macAddress: string,
): Promise<void> {
    const baseUrl = iliadboxUrl.replace(/\/+$/, '');
    const cookieJar: CookieJar = {};
    const commonHeaders = { 'X-FBX-FREEBOX0S': '1' };

    const loginState = await axios.get(`${baseUrl}/api/latest/login/`, {
        timeout: 10_000,
        httpsAgent: iliadboxAgent,
        headers: commonHeaders,
    });
    updateCookieJar(cookieJar, loginState.headers['set-cookie']);

    if (!loginState.data?.success) {
        throw new Error(`login_state_failed: ${JSON.stringify(loginState.data)}`);
    }

    if (!loginState.data.result?.logged_in) {
        const challengeTable = loginState.data.result?.challenge;
        const passwordSalt = loginState.data.result?.password_salt;

        if (!Array.isArray(challengeTable) || typeof passwordSalt !== 'string') {
            throw new Error('invalid_login_challenge');
        }

        const challenge = getIliadboxChallenge(challengeTable);
        const hashedPassword = crypto.createHash('sha1').update(passwordSalt + password).digest('hex');
        const responseHash = crypto.createHmac('sha1', hashedPassword).update(challenge).digest('hex');

        const login = await axios.post(
            `${baseUrl}/api/latest/login/`,
            new URLSearchParams({ password: responseHash }).toString(),
            {
                timeout: 10_000,
                httpsAgent: iliadboxAgent,
                headers: {
                    ...commonHeaders,
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    ...(cookieHeader(cookieJar) ? { Cookie: cookieHeader(cookieJar) } : {}),
                },
            },
        );
        updateCookieJar(cookieJar, login.headers['set-cookie']);

        if (!login.data?.success) throw new Error(`login_failed: ${JSON.stringify(login.data)}`);
    }

    const wol = await axios.post(
        `${baseUrl}/api/latest/lan/wol/pub/`,
        { mac: macAddress, password: '' },
        {
            timeout: 10_000,
            httpsAgent: iliadboxAgent,
            headers: {
                ...commonHeaders,
                ...(cookieHeader(cookieJar) ? { Cookie: cookieHeader(cookieJar) } : {}),
            },
        },
    );

    if (!wol.data?.success) throw new Error(`wol_api_failed: ${JSON.stringify(wol.data)}`);
}

export const iliadboxWakeMethod: WakeMethod = {
    id: 'iliadbox',
    label: 'Iliadbox / Freebox router API',
    description: 'Fa emettere il magic packet al router stesso: utile quando il pacchetto non riesce ad arrivare in LAN da fuori.',
    fields: [
        {
            name: 'iliadboxUrl',
            kind: 'url',
            label: 'Router address',
            hint: 'As reachable from the machine running Lestapenna.',
            required: true,
            placeholder: 'https://192.168.1.1',
        },
        {
            name: 'password',
            kind: 'password',
            label: 'Router admin password',
            hint: 'Stored encrypted, like every other credential.',
            required: true,
            secret: true,
        },
    ],

    async send(config: WakeConfig): Promise<void> {
        const url = String(config.options.iliadboxUrl ?? '');
        const password = config.secrets.password;
        if (!url) throw new Error('iliadbox_url_missing');
        if (!password) throw new Error('iliadbox_password_missing');

        console.log(`[WoL] Wake request via API router → ${url} (MAC: ${config.macAddress})`);
        await sendIliadboxWakeRequest(url, password, config.macAddress);
    },
};
