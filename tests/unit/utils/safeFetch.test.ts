/**
 * The guard that stops a user-supplied URL from becoming a way into the
 * internal network.
 *
 * `$debug teststream` takes a link from Discord and downloads it from inside the
 * host, so «is it a valid URL» is not the question — «where does it actually
 * land» is. These tests defend the three places where that goes wrong: a
 * non-public address, a redirect that walks towards one after a public first
 * hop, and a body that keeps coming until the disk is full.
 */

// `dns/promises` exports non-configurable properties: jest.spyOn cannot replace
// them, so the whole module has to be substituted.
const mockLookup = jest.fn();
jest.mock('dns/promises', () => ({ lookup: (...args: unknown[]) => mockLookup(...args) }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    isBlockedAddress,
    assertPublicUrl,
    UnsafeUrlError,
    byteCap,
    safeDownloadToFile,
} from '../../../src/utils/safeFetch';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

describe('isBlockedAddress', () => {
    it.each([
        ['127.0.0.1', 'loopback'],
        ['10.0.0.5', 'private 10/8'],
        ['172.16.0.1', 'private 172.16/12'],
        ['172.31.255.254', 'top end of 172.16/12'],
        ['192.168.1.1', 'private 192.168/16'],
        ['169.254.169.254', 'cloud metadata'],
        ['100.64.0.1', 'CGNAT'],
        ['0.0.0.0', 'this network'],
        ['224.0.0.1', 'multicast'],
        ['::1', 'IPv6 loopback'],
        ['fd00::1', 'IPv6 unique local'],
        ['fe80::1', 'IPv6 link-local'],
        ['::ffff:127.0.0.1', 'IPv4 loopback disguised as IPv6'],
        ['not-an-ip', 'a string that is not an address'],
    ])('blocks %s (%s)', (ip) => {
        expect(isBlockedAddress(ip)).toBe(true);
    });

    it.each([
        ['8.8.8.8'],
        ['1.1.1.1'],
        ['172.15.0.1'],   // just OUTSIDE 172.16/12
        ['172.32.0.1'],   // just OUTSIDE the other end
        ['192.167.1.1'],  // just outside 192.168/16
        ['2606:4700::1'], // public IPv6
    ])('lets %s through', (ip) => {
        expect(isBlockedAddress(ip)).toBe(false);
    });
});

describe('assertPublicUrl', () => {
    beforeEach(() => mockLookup.mockReset());

    it('rejects schemes other than http/https', async () => {
        await expect(assertPublicUrl('file:///etc/passwd')).rejects.toBeInstanceOf(UnsafeUrlError);
        await expect(assertPublicUrl('ftp://example.test/a.mp3')).rejects.toBeInstanceOf(UnsafeUrlError);
    });

    it('rejects a literal private IP without asking DNS at all', async () => {
        await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/'))
            .rejects.toThrow(/non-public address/i);
        expect(mockLookup).not.toHaveBeenCalled();
    });

    it('rejects a name that resolves to a private address', async () => {
        mockLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
        await expect(assertPublicUrl('https://internal.example.test/a.mp3'))
            .rejects.toThrow(/non-public address/i);
    });

    it('rejects when EVEN ONE of the addresses is private', async () => {
        // Accepting one because the other is public would be enough to get
        // through: which of the two gets used is not our choice.
        mockLookup.mockResolvedValue([
            { address: '8.8.8.8', family: 4 },
            { address: '127.0.0.1', family: 4 },
        ]);
        await expect(assertPublicUrl('https://mixed.example.test/a.mp3'))
            .rejects.toThrow(/non-public address/i);
    });

    it('accepts a name that resolves to a public address', async () => {
        mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        const url = await assertPublicUrl('https://example.test/audio.mp3');
        expect(url.hostname).toBe('example.test');
    });

    it('rejects a host that does not resolve', async () => {
        mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
        await expect(assertPublicUrl('https://nonexistent.test/a.mp3'))
            .rejects.toThrow(/does not resolve/i);
    });
});

describe('byteCap', () => {
    it('lets a body under the cap through', async () => {
        const chunks: Buffer[] = [];
        await pipeline(
            Readable.from([Buffer.alloc(10), Buffer.alloc(10)]),
            byteCap(100),
            async function (source) { for await (const c of source) chunks.push(c as Buffer); },
        );
        expect(Buffer.concat(chunks)).toHaveLength(20);
    });

    it('aborts as soon as the cap is exceeded, without waiting for the end', async () => {
        // The counting happens on the stream precisely because Content-Length
        // can lie: this stream does not declare it at all.
        await expect(pipeline(
            Readable.from([Buffer.alloc(60), Buffer.alloc(60)]),
            byteCap(100),
            async function (source) { for await (const _ of source) { /* discard */ } },
        )).rejects.toThrow(/too large/i);
    });
});

describe('safeDownloadToFile', () => {
    let dir: string;
    let dest: string;
    const realFetch = global.fetch;

    beforeEach(() => {
        mockLookup.mockReset();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safefetch-'));
        dest = path.join(dir, 'out.mp3');
    });

    afterEach(() => {
        global.fetch = realFetch;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /** A redirect response, as `fetch` would return it with redirect: 'manual'. */
    const redirectTo = (location: string) =>
        new Response(null, { status: 302, headers: { location } });

    it('re-checks the destination on every redirect, not just the first URL', async () => {
        // This is the case that makes validating only the initial URL pointless:
        // the first hop is a perfectly public host, and the 302 is what walks
        // towards the cloud metadata endpoint.
        mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        global.fetch = jest.fn()
            .mockResolvedValueOnce(redirectTo('http://169.254.169.254/latest/meta-data/')) as never;

        await expect(safeDownloadToFile('https://public.example.test/a.mp3', dest, { maxBytes: 1024 }))
            .rejects.toThrow(/non-public address/i);
        expect(fs.existsSync(dest)).toBe(false);
    });

    it('gives up after too many redirects instead of looping forever', async () => {
        mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        global.fetch = jest.fn()
            .mockResolvedValue(redirectTo('https://public.example.test/again.mp3')) as never;

        await expect(safeDownloadToFile('https://public.example.test/a.mp3', dest, { maxBytes: 1024 }))
            .rejects.toThrow(/too many redirects/i);
    });

    it('rejects an unexpected content type', async () => {
        mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        global.fetch = jest.fn().mockResolvedValue(
            new Response('<html>nope</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
        ) as never;

        await expect(safeDownloadToFile('https://public.example.test/a.mp3', dest, {
            maxBytes: 1024,
            allowedContentTypes: ['audio/'],
        })).rejects.toThrow(/unexpected content type/i);
    });

    it('writes the file when everything checks out', async () => {
        mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        global.fetch = jest.fn().mockResolvedValue(
            new Response('fake-audio', { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
        ) as never;

        await safeDownloadToFile('https://public.example.test/a.mp3', dest, {
            maxBytes: 1024,
            allowedContentTypes: ['audio/'],
        });
        expect(fs.readFileSync(dest, 'utf8')).toBe('fake-audio');
    });

    it('does not leave a partial file behind when the cap is exceeded', async () => {
        // A truncated audio file left on disk would be fed to the pipeline as if
        // it were whole.
        mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        global.fetch = jest.fn().mockResolvedValue(
            new Response('x'.repeat(500), { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
        ) as never;

        await expect(safeDownloadToFile('https://public.example.test/a.mp3', dest, { maxBytes: 100 }))
            .rejects.toThrow(/too large/i);
        expect(fs.existsSync(dest)).toBe(false);
    });
});
