import {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    type ListObjectsV2CommandOutput,
    PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { promises as fs } from 'fs';
import * as path from 'path';
import { config } from '../config';
import { getS3Client } from './backup';
import { logger } from '../utils/logger';

const log = logger('EntityMediaStorage');
const OBJECT_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/;

export type EntityMediaReadResult =
    | { kind: 'redirect'; url: string }
    | { kind: 'buffer'; body: Buffer };

function validateObjectKey(key: string): void {
    if (!OBJECT_KEY_RE.test(key) || key.includes('..') || key.startsWith('/')) {
        throw new Error('Invalid media object key');
    }
}

function localPathFor(key: string): string {
    validateObjectKey(key);
    const root = path.resolve(config.mediaStorage.localDirectory);
    const target = path.resolve(root, key);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Media path escapes local storage root');
    return target;
}

/** Files under a local directory, counted so the local driver can report the same number the OCI one does. */
async function countLocalFiles(target: string): Promise<number> {
    let entries;
    try {
        entries = await fs.readdir(target, { withFileTypes: true });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // A prefix that is a single file, or one that never existed.
        if (code === 'ENOTDIR') return 1;
        if (code === 'ENOENT') return 0;
        throw error;
    }

    let count = 0;
    for (const entry of entries) {
        count += entry.isDirectory() ? await countLocalFiles(path.join(target, entry.name)) : 1;
    }
    return count;
}

function assertConfigured(): void {
    const { driver, bucketName } = config.mediaStorage;
    if (process.env.NODE_ENV === 'production' && driver !== 'oci') {
        throw new Error('[MediaStorage] Production requires MEDIA_STORAGE_DRIVER=oci');
    }
    if (driver === 'oci' && !bucketName) {
        throw new Error('[MediaStorage] OCI_MEDIA_BUCKET_NAME is required for the OCI media driver');
    }
    if (driver === 'local' && process.env.NODE_ENV === 'production') {
        throw new Error('[MediaStorage] Local media storage is forbidden in production');
    }
}

/**
 * Entity images never share the recordings bucket. Local storage exists only
 * for tests and explicitly opted-in development.
 */
export class EntityMediaStorage {
    constructor() {
        assertConfigured();
    }

    isEnabled(): boolean {
        return config.mediaStorage.driver !== 'disabled';
    }

    private requireEnabled(): void {
        if (!this.isEnabled()) {
            throw new Error(
                '[MediaStorage] Disabled. Configure a private OCI_MEDIA_BUCKET_NAME or opt into MEDIA_STORAGE_DRIVER=local in development.',
            );
        }
    }

    async put(key: string, body: Buffer, contentType = 'image/webp'): Promise<void> {
        this.requireEnabled();
        validateObjectKey(key);
        if (config.mediaStorage.driver === 'local') {
            const target = localPathFor(key);
            await fs.mkdir(path.dirname(target), { recursive: true });
            const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
            await fs.writeFile(temporary, body, { flag: 'wx' });
            await fs.rename(temporary, target);
            return;
        }

        await getS3Client().send(
            new PutObjectCommand({
                Bucket: config.mediaStorage.bucketName!,
                Key: key,
                Body: body,
                ContentType: contentType,
                CacheControl: 'private, max-age=31536000, immutable',
            }),
        );
    }

    /**
     * The bytes themselves, server-side.
     *
     * Distinct from `read()`, and it has to be: on the OCI driver that one hands
     * the browser a presigned URL, which is the right answer for showing a
     * picture and no answer at all for the one caller that must *hold* the
     * bytes — accepting a generated portrait, which feeds them back through the
     * very same upload path an uploaded file takes.
     */
    async getBuffer(key: string): Promise<Buffer | null> {
        this.requireEnabled();
        validateObjectKey(key);
        if (config.mediaStorage.driver === 'local') {
            try {
                return await fs.readFile(localPathFor(key));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw error;
            }
        }

        try {
            const response = await getS3Client().send(
                new GetObjectCommand({ Bucket: config.mediaStorage.bucketName!, Key: key }),
            );
            const body = response.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
            if (!body?.transformToByteArray) return null;
            return Buffer.from(await body.transformToByteArray());
        } catch (error) {
            const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
            if (status === 404 || (error as { name?: string }).name === 'NoSuchKey') return null;
            log.error(`Media fetch failed for ${key}`, error as Error);
            throw error;
        }
    }

    async delete(key: string): Promise<void> {
        this.requireEnabled();
        validateObjectKey(key);
        if (config.mediaStorage.driver === 'local') {
            try {
                await fs.unlink(localPathFor(key));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            return;
        }

        await getS3Client().send(
            new DeleteObjectCommand({
                Bucket: config.mediaStorage.bucketName!,
                Key: key,
            }),
        );
    }

    /**
     * Every object under a prefix, on the **media** bucket.
     *
     * `backup.ts#deleteByPrefix` looks like it would do, and that resemblance is
     * exactly how the erasure paths came to sweep `media/{guildId}/` against
     * `OCI_BUCKET_NAME` — the recordings bucket, where no picture has ever been
     * written. A bucket is not a parameter there, so the only way to delete a
     * prefix from the right bucket is to own the loop here.
     *
     * Returns how many objects went, so a caller reporting an erasure can say
     * something true about the storage rather than only about the database.
     */
    async deleteByPrefix(prefix: string): Promise<number> {
        this.requireEnabled();
        validateObjectKey(prefix);

        if (config.mediaStorage.driver === 'local') {
            const target = localPathFor(prefix);
            const count = await countLocalFiles(target);
            await fs.rm(target, { recursive: true, force: true });
            return count;
        }

        const client = getS3Client();
        const bucket = config.mediaStorage.bucketName!;
        // Oracle Object Storage rejects the bulk DeleteObjectsCommand ("Missing
        // required header ... Content-MD5"), so objects go one at a time.
        const CONCURRENCY = 25;
        let deleted = 0;

        try {
            let continuationToken: string | undefined = undefined;
            do {
                const response: ListObjectsV2CommandOutput = await client.send(
                    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
                );
                const keys = (response.Contents || []).map(object => object.Key).filter((key): key is string => !!key);

                for (let i = 0; i < keys.length; i += CONCURRENCY) {
                    const batch = keys.slice(i, i + CONCURRENCY);
                    await Promise.all(batch.map(key => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))));
                    deleted += batch.length;
                }

                continuationToken = response.NextContinuationToken;
            } while (continuationToken);

            return deleted;
        } catch (error) {
            // Erasure has to report a partial failure — data that survives a
            // deletion is the one outcome nobody may round down to success.
            log.error(`Media prefix deletion failed for ${prefix}`, error as Error);
            throw error;
        }
    }

    async read(key: string): Promise<EntityMediaReadResult | null> {
        this.requireEnabled();
        validateObjectKey(key);
        if (config.mediaStorage.driver === 'local') {
            try {
                return { kind: 'buffer', body: await fs.readFile(localPathFor(key)) };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw error;
            }
        }

        try {
            await getS3Client().send(
                new HeadObjectCommand({ Bucket: config.mediaStorage.bucketName!, Key: key }),
            );
            const url = await getSignedUrl(
                getS3Client(),
                new GetObjectCommand({ Bucket: config.mediaStorage.bucketName!, Key: key }),
                { expiresIn: 5 * 60 },
            );
            return { kind: 'redirect', url };
        } catch (error) {
            const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
            if (status === 404 || (error as { name?: string }).name === 'NotFound') return null;
            log.error(`Media read failed for ${key}`, error as Error);
            throw error;
        }
    }
}
