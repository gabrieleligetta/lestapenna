/**
 * Downloading a user-supplied URL without turning it into a way into the
 * internal network.
 *
 * A `fetch(url)` on an address that arrives from Discord is not a request
 * towards «the internet»: it is a request that starts **inside** the host, so it
 * reaches Redis, the database, the sibling containers and — on a cloud machine —
 * the metadata endpoint (169.254.169.254), which hands the instance credentials
 * to anyone who knows how to ask. This is the class of bug known as SSRF, and
 * the defence is not validating the *string* but validating the **IP address**
 * that string resolves to.
 *
 * Hence the three rules applied below:
 *
 *  1. `http`/`https` only — `file:`, `gopher:` and friends have no business in a
 *     command that downloads audio;
 *  2. every resolved address must be public, and the check is repeated **on
 *     every redirect**: validating only the initial URL is worth nothing if we
 *     then follow a 302 pointing at 127.0.0.1;
 *  3. a size cap applied **while writing**, because `Content-Length` is declared
 *     by whoever answers and may lie or be absent.
 *
 * ⚠️ Known and accepted limit: between our DNS resolution and the one `fetch`
 * does there is a window in which a hostile domain can change its answer (DNS
 * rebinding). Closing it means connecting to the already-validated IP while
 * forcing the Host header, i.e. a bespoke HTTP agent. For a command reserved to
 * server operators that is disproportionate; for a public endpoint it would not
 * be — so do not reuse this module in that context without closing the window
 * first.
 */

import * as dns from 'dns/promises';
import * as net from 'net';
import * as fs from 'fs';
import { pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';

/** How many redirects to follow before giving up. */
const MAX_REDIRECTS = 5;

/** Rejection error: the caller shows it to the user as-is. */
export class UnsafeUrlError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnsafeUrlError';
    }
}

/**
 * `true` when the IP does not belong to the publicly routable space.
 *
 * The list is longer than just the private ranges: loopback, link-local (which
 * includes the cloud metadata service), CGNAT, benchmarking, multicast and
 * reserved are all different ways of saying «this is not a server on the
 * internet».
 */
export function isBlockedAddress(ip: string): boolean {
    const version = net.isIP(ip);
    if (version === 0) return true; // not an IP: we do not know what it is, so no

    if (version === 6) {
        const lower = ip.toLowerCase();

        // IPv4-mapped addresses (::ffff:127.0.0.1) are IPv4 in disguise:
        // judging them as IPv6 would let every one of them through.
        const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isBlockedAddress(mapped[1]);

        if (lower === '::' || lower === '::1') return true;
        // fc00::/7 (unique local) — first byte 0xfc or 0xfd
        if (/^f[cd]/.test(lower)) return true;
        // fe80::/10 (link-local)
        if (/^fe[89ab]/.test(lower)) return true;
        return false;
    }

    const [a, b] = ip.split('.').map(Number);

    if (a === 0) return true;                         // 0.0.0.0/8   «this network»
    if (a === 10) return true;                        // 10/8        private
    if (a === 127) return true;                       // 127/8       loopback
    if (a === 169 && b === 254) return true;          // 169.254/16  link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12   private
    if (a === 192 && b === 168) return true;          // 192.168/16  private
    if (a === 192 && b === 0) return true;            // 192.0.0/24  IETF assignments
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10  CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
    if (a >= 224) return true;                        // 224/4 multicast, 240/4 reserved

    return false;
}

/**
 * Checks an URL's scheme and destination. Throws `UnsafeUrlError` when it fails.
 * Exported separately because it is the piece worth testing on its own.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new UnsafeUrlError(`Invalid URL: ${rawUrl}`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new UnsafeUrlError(`Scheme not allowed: ${parsed.protocol} (http/https only)`);
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, ''); // a literal IPv6 arrives in brackets

    // When the host already is an IP there is no DNS to ask, and it must not be
    // asked: `dns.lookup` on a literal would just echo it back.
    if (net.isIP(hostname)) {
        if (isBlockedAddress(hostname)) {
            throw new UnsafeUrlError(`Non-public address: ${hostname}`);
        }
        return parsed;
    }

    let addresses: Array<{ address: string; family: number }>;
    try {
        addresses = await dns.lookup(hostname, { all: true });
    } catch {
        throw new UnsafeUrlError(`Host does not resolve: ${hostname}`);
    }

    if (!addresses.length) {
        throw new UnsafeUrlError(`Host with no addresses: ${hostname}`);
    }

    // ALL addresses must be public: if a name returned two and we accepted it on
    // the strength of one, it would be enough for the system to pick the other.
    for (const { address } of addresses) {
        if (isBlockedAddress(address)) {
            throw new UnsafeUrlError(`${hostname} points at a non-public address (${address})`);
        }
    }

    return parsed;
}

export interface SafeDownloadOptions {
    /** Size cap, in bytes. */
    maxBytes: number;
    /** When set, the content-type must start with one of these prefixes. */
    allowedContentTypes?: string[];
}

/**
 * Downloads `rawUrl` into `destPath` applying the three rules described at the
 * top. On failure the partial file is removed: leaving it behind would feed the
 * pipeline a truncated audio file.
 */
export async function safeDownloadToFile(
    rawUrl: string,
    destPath: string,
    opts: SafeDownloadOptions,
): Promise<void> {
    let currentUrl = rawUrl;
    let response: Response | undefined;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const validated = await assertPublicUrl(currentUrl);

        const res = await fetch(validated, { redirect: 'manual' });

        if ([301, 302, 303, 307, 308].includes(res.status)) {
            const location = res.headers.get('location');
            if (!location) {
                throw new UnsafeUrlError(`Redirect ${res.status} without a Location header`);
            }
            // Resolved against the current URL: a relative Location is
            // legitimate, and next time round it goes through assertPublicUrl
            // anyway.
            currentUrl = new URL(location, validated).toString();
            continue;
        }

        response = res;
        break;
    }

    if (!response) {
        throw new UnsafeUrlError(`Too many redirects (more than ${MAX_REDIRECTS})`);
    }

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    if (opts.allowedContentTypes?.length) {
        const contentType = response.headers.get('content-type') || '';
        const ok = opts.allowedContentTypes.some(prefix => contentType.startsWith(prefix));
        if (!ok) {
            throw new UnsafeUrlError(`Unexpected content type: ${contentType || 'absent'}`);
        }
    }

    if (!response.body) {
        throw new Error('Response with no body');
    }

    try {
        await pipeline(
            Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
            byteCap(opts.maxBytes),
            fs.createWriteStream(destPath),
        );
    } catch (err) {
        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch { /* nothing to do */ }
        throw err;
    }
}

/**
 * Pipeline stage that counts bytes and aborts as soon as the cap is exceeded.
 *
 * The counting happens here rather than on `Content-Length` because that header
 * is declared by whoever answers: it can be omitted, or understated while the
 * body keeps streaming until the disk is full.
 */
export function byteCap(maxBytes: number): Transform {
    let written = 0;
    return new Transform({
        transform(chunk: Buffer, _enc, cb) {
            written += chunk.length;
            if (written > maxBytes) {
                cb(new UnsafeUrlError(
                    `Content too large: over ${(maxBytes / 1024 / 1024).toFixed(0)} MB`,
                ));
                return;
            }
            cb(null, chunk);
        },
    });
}
