import {
    DeleteObjectCommand,
    GetObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
} from '@aws-sdk/client-s3';
import { promises as fs } from 'fs';
import type { Dirent } from 'fs';
import * as path from 'path';
import { config } from '../config';
import { getS3Client } from './backup';

const OBJECT_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/;

function validateObjectKey(key: string): void {
    if (!OBJECT_KEY_RE.test(key) || key.includes('..') || key.startsWith('/')) {
        throw new Error('Invalid report object key');
    }
}

function localPathFor(key: string): string {
    validateObjectKey(key);
    const root = path.resolve(config.reportsStorage.localDirectory);
    const target = path.resolve(root, key);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Report path escapes local storage root');
    return target;
}

/**
 * Stores user-submitted bug/issue reports as JSON in the same private bucket
 * as entity media (prefixed `reports/`), so an AI agent can read and triage
 * them without connecting to the production database. Unlike entity media,
 * report JSON is mutable (the agent updates status) and must never be cached
 * as immutable, hence a dedicated storage class rather than reusing
 * {@link import('./entityMediaStorage').EntityMediaStorage} which hardcodes
 * `image/webp` + an immutable cache-control.
 *
 * Driver defaults to `oci` (non-test) so reports from both local preview and
 * production aggregate in the same bucket; the test suite uses `local`.
 */
export class ReportsStorage {
    isEnabled(): boolean {
        return config.reportsStorage.driver !== 'disabled';
    }

    private requireEnabled(): void {
        if (!this.isEnabled()) {
            throw new Error(
                '[ReportsStorage] Disabled. Configure OCI_REPORTS_BUCKET_NAME (or OCI_MEDIA_BUCKET_NAME) with OCI credentials, or set REPORTS_STORAGE_DRIVER=local for a local fallback.',
            );
        }
        if (config.reportsStorage.driver === 'oci' && !config.reportsStorage.bucketName) {
            throw new Error(
                '[ReportsStorage] OCI_REPORTS_BUCKET_NAME (or OCI_MEDIA_BUCKET_NAME) is required when REPORTS_STORAGE_DRIVER=oci.',
            );
        }
    }

    /** List every object key under `prefix` (non-recursive on OCI, recursive on local). */
    async list(prefix: string): Promise<string[]> {
        this.requireEnabled();
        validateObjectKey(prefix);
        if (config.reportsStorage.driver === 'local') {
            const root = path.resolve(config.reportsStorage.localDirectory);
            const out: string[] = [];
            const walk = async (dir: string): Promise<void> => {
                let entries: Dirent[];
                try {
                    entries = await fs.readdir(dir, { withFileTypes: true });
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
                    throw error;
                }
                for (const entry of entries) {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await walk(full);
                    } else {
                        const rel = path.relative(root, full).split(path.sep).join('/');
                        if (rel.startsWith(prefix)) out.push(rel);
                    }
                }
            };
            await walk(root);
            return out.sort();
        }

        const keys: string[] = [];
        let token: string | undefined;
        do {
            const res = await getS3Client().send(
                new ListObjectsV2Command({
                    Bucket: config.reportsStorage.bucketName!,
                    Prefix: prefix,
                    ContinuationToken: token,
                }),
            );
            for (const obj of res.Contents ?? []) {
                if (obj.Key) keys.push(obj.Key);
            }
            token = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (token);
        return keys.sort();
    }

    /** Read an object's bytes. Used by the backend to build the index. */
    async readBuffer(key: string): Promise<Buffer | null> {
        this.requireEnabled();
        validateObjectKey(key);
        if (config.reportsStorage.driver === 'local') {
            try {
                return await fs.readFile(localPathFor(key));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw error;
            }
        }
        const res = await getS3Client().send(
            new GetObjectCommand({ Bucket: config.reportsStorage.bucketName!, Key: key }),
        );
        if (!res.Body) return null;
        const bytes = await res.Body.transformToByteArray();
        return Buffer.from(bytes);
    }

    /** Write a report JSON object with `no-store` (the agent mutates it). */
    async putJson(key: string, body: Buffer): Promise<void> {
        this.requireEnabled();
        validateObjectKey(key);
        if (config.reportsStorage.driver === 'local') {
            const target = localPathFor(key);
            await fs.mkdir(path.dirname(target), { recursive: true });
            const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
            await fs.writeFile(temporary, body, { flag: 'wx' });
            await fs.rename(temporary, target);
            return;
        }
        await getS3Client().send(
            new PutObjectCommand({
                Bucket: config.reportsStorage.bucketName!,
                Key: key,
                Body: body,
                ContentType: 'application/json; charset=utf-8',
                CacheControl: 'no-store',
            }),
        );
    }

    /** Write a screenshot WebP variant (immutable is fine — screenshots are never overwritten). */
    async putImage(key: string, body: Buffer): Promise<void> {
        this.requireEnabled();
        validateObjectKey(key);
        if (config.reportsStorage.driver === 'local') {
            const target = localPathFor(key);
            await fs.mkdir(path.dirname(target), { recursive: true });
            const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
            await fs.writeFile(temporary, body, { flag: 'wx' });
            await fs.rename(temporary, target);
            return;
        }
        await getS3Client().send(
            new PutObjectCommand({
                Bucket: config.reportsStorage.bucketName!,
                Key: key,
                Body: body,
                ContentType: 'image/webp',
                CacheControl: 'private, max-age=31536000, immutable',
            }),
        );
    }

    async delete(key: string): Promise<void> {
        this.requireEnabled();
        validateObjectKey(key);
        if (config.reportsStorage.driver === 'local') {
            try {
                await fs.unlink(localPathFor(key));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            return;
        }
        await getS3Client().send(
            new DeleteObjectCommand({ Bucket: config.reportsStorage.bucketName!, Key: key }),
        );
    }
}