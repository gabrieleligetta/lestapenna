import 'dotenv/config';
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, ListObjectsV2CommandOutput, ListBucketsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { config } from '../config';
import { withRetry } from '../utils/retry';
import { logger } from '../utils/logger';

const log = logger('Custode');

let _s3Client: S3Client | null = null;
const MAX_CONCURRENT_UPLOADS = Math.max(1, Number.parseInt(process.env.MAX_CONCURRENT_UPLOADS || '2', 10) || 2);
let activeUploads = 0;
const uploadWaiters: Array<() => void> = [];

async function withUploadSlot<T>(work: () => Promise<T>): Promise<T> {
    if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
        await new Promise<void>(resolve => uploadWaiters.push(resolve));
    }
    activeUploads++;
    try {
        return await work();
    } finally {
        activeUploads--;
        uploadWaiters.shift()?.();
    }
}

export function getS3Client(): S3Client {
    if (!_s3Client) {
        const { region, endpoint, accessKeyId, secretAccessKey } = config.oci;

        if (!region || !endpoint || !accessKeyId || !secretAccessKey) {
            log.error("Variabili d'ambiente OCI mancanti o incomplete!");
        }

        log.info(`Inizializzazione S3 Client. Region: ${region}, Endpoint: ${endpoint}`);

        _s3Client = new S3Client({
            region: region,
            endpoint: endpoint,
            credentials: {
                accessKeyId: accessKeyId,
                secretAccessKey: secretAccessKey,
            },
            forcePathStyle: true,
            // OCI's S3 compatibility layer rejects the trailing checksums that
            // recent AWS SDKs send as `Content-Encoding: aws-chunked`. Oracle's
            // documented compatibility setting is WHEN_REQUIRED; PutObject does
            // not require that optional trailer and can use a regular fixed-size
            // request instead.
            requestChecksumCalculation: 'WHEN_REQUIRED',
        });
    }
    return _s3Client;
}

export const getBucketName = () => config.oci.bucketName;

/**
 * Resolve the guildId for a session from DB (lazy, cached per-call).
 * Returns undefined if DB module not loaded yet or session not found.
 */
function resolveGuildId(sessionId?: string): string | undefined {
    if (!sessionId) return undefined;
    try {
        // Dynamic import to avoid circular dependency at module load time
        const { getSessionGuildId } = require('../db');
        return getSessionGuildId(sessionId);
    } catch {
        return undefined;
    }
}

/**
 * Utility to get the preferred S3 key.
 * New structure: recordings/{guildId}/{sessionId}/{fileName}
 * Fallback when guildId is unavailable: recordings/{sessionId}/{fileName}
 */
function getPreferredKey(fileName: string, sessionId?: string, guildId?: string): string {
    if (sessionId && guildId) {
        return `recordings/${guildId}/${sessionId}/${fileName}`;
    }
    if (sessionId) {
        // Try to resolve guildId from DB
        const resolved = resolveGuildId(sessionId);
        if (resolved) {
            return `recordings/${resolved}/${sessionId}/${fileName}`;
        }
        return `recordings/${sessionId}/${fileName}`;
    }
    return `recordings/${fileName}`;
}

/**
 * Checks whether a file exists in the OCI bucket, looking at:
 * 1. The new tenant path: recordings/{guildId}/{sessionId}/{fileName}
 * 2. The old session path: recordings/{sessionId}/{fileName}
 * 3. The legacy path: recordings/{fileName}
 * Returns the Key when found, null otherwise.
 */
async function findS3Key(fileName: string, sessionId?: string): Promise<string | null> {
    if (sessionId) {
        // If fileName already carries a path (e.g. transcripts/...), use it as is
        if (fileName.includes('/')) {
            try {
                await getS3Client().send(new HeadObjectCommand({ Bucket: getBucketName(), Key: fileName }));
                return fileName;
            } catch (err: any) {
                if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) {
                    log.error(`Errore verifica existence per ${fileName}`, err);
                }
            }
            return null;
        }

        // 1. Try the new tenant path: recordings/{guildId}/{sessionId}/{fileName}
        const guildId = resolveGuildId(sessionId);
        if (guildId) {
            const tenantKey = `recordings/${guildId}/${sessionId}/${fileName}`;
            try {
                await getS3Client().send(new HeadObjectCommand({ Bucket: getBucketName(), Key: tenantKey }));
                return tenantKey;
            } catch (err: any) {
                if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) {
                    log.error(`Errore verifica existence per ${tenantKey}`, err);
                }
            }
        }

        // 2. Try the old session path: recordings/{sessionId}/{fileName}
        const sessionKey = `recordings/${sessionId}/${fileName}`;
        try {
            await getS3Client().send(new HeadObjectCommand({ Bucket: getBucketName(), Key: sessionKey }));
            return sessionKey;
        } catch (err: any) {
            if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) {
                log.error(`Errore verifica existence per ${sessionKey}`, err);
            }
        }
    }

    // 3. Try the legacy path (the root of recordings)
    if (!fileName.includes('/')) {
        const legacyKey = `recordings/${fileName}`;
        try {
            await getS3Client().send(new HeadObjectCommand({ Bucket: getBucketName(), Key: legacyKey }));
            return legacyKey;
        } catch (err: any) {
            if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) {
                log.error(`Errore verifica existence per ${legacyKey}`, err);
            }
        }
    }

    return null;
}

/**
 * Checks whether a downloadable object exists without minting a signed URL.
 *
 * Full keys are checked exactly. Bare filenames retain the tenant/session/
 * legacy lookup used by the existing download helpers.
 */
export async function cloudObjectExists(fileNameOrKey: string, sessionId?: string): Promise<boolean> {
    if (!fileNameOrKey.includes('/')) {
        return (await findS3Key(fileNameOrKey, sessionId)) !== null;
    }

    try {
        await getS3Client().send(new HeadObjectCommand({
            Bucket: getBucketName(),
            Key: fileNameOrKey,
        }));
        return true;
    } catch (err: any) {
        if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) {
            log.error(`Errore verifica existence per ${fileNameOrKey}`, err);
        }
        return false;
    }
}

/**
 * Uploads a file to Oracle Cloud, only when it is not already there.
 */
export async function uploadToOracle(filePath: string, fileName: string, sessionId?: string, customKey?: string): Promise<string | null> {
    try {
        // 1. Check whether the file already exists in the Cloud (in any location)
        // When customKey is supplied we skip the "smart" existence check and trust it
        if (!customKey) {
            const existingKey = await findS3Key(fileName, sessionId);
            if (existingKey) {
                log.info(`Salto upload, file già presente su Oracle: ${existingKey}`);
                return fileName;
            }
        }

        // 2. Check whether the local file exists
        if (!fs.existsSync(filePath)) {
            log.error(`Impossibile caricare: file locale non trovato ${filePath}`);
            return null;
        }

        const targetKey = customKey ? customKey : getPreferredKey(fileName, sessionId);
        const contentLength = fs.statSync(filePath).size;

        // Determine the content type from the extension
        const extension = path.extname(fileName).toLowerCase();
        const contentType = extension === '.ogg' ? 'audio/ogg' :
            extension === '.mp3' ? 'audio/mpeg' :
                extension === '.flac' ? 'audio/flac' :
                    extension === '.json' ? 'application/json' :
                        extension === '.txt' ? 'text/plain' :
                            'audio/x-pcm';

        await withUploadSlot(async () => {
            // A fresh stream is required for every retry. Reading the complete
            // FLAC synchronously used to stop Discord's event loop and duplicate
            // the file in heap while voices were arriving.
            await withRetry(async () => {
                const body = fs.createReadStream(filePath);
                await new Promise<void>((resolve, reject) => {
                    body.once('open', () => resolve());
                    body.once('error', reject);
                });
                try {
                    await getS3Client().send(new PutObjectCommand({
                        Bucket: getBucketName(),
                        Key: targetKey,
                        Body: body,
                        // A file stream has no intrinsic length. Declaring it
                        // prevents transfer-encoding chunked and lets OCI reject
                        // a truncated request instead of accepting ambiguity.
                        ContentLength: contentLength,
                        ContentType: contentType,
                    }));
                } finally {
                    // The SDK normally drains it; explicit destruction also
                    // makes mocked/short-circuited sends release the fd safely.
                    body.destroy();
                }
            }, 3, 1000, `upload ${targetKey}`);
        });
        log.info(`Backup completato su Oracle: ${targetKey}`);

        return fileName;
    } catch (err) {
        log.error(`Errore backup su Oracle per ${fileName}`, err as Error);
        return null;
    }
}

/**
 * Deletes a file from Oracle Cloud.
 * It looks for the file in both the session and the legacy path and removes it.
 */
export async function deleteFromOracle(fileName: string, sessionId?: string): Promise<boolean> {
    try {
        const key = await findS3Key(fileName, sessionId);

        // When not found via findS3Key, we still try to delete the expected target key
        // This handles the case where findS3Key fails or we want to be sure the destination is clean
        const targetKey = key || getPreferredKey(fileName, sessionId);

        await withRetry(() => getS3Client().send(new DeleteObjectCommand({
            Bucket: getBucketName(),
            Key: targetKey
        })), 3, 1000, `delete ${targetKey}`);

        log.info(`Eliminato da Oracle: ${targetKey}`);
        return true;
    } catch (err: any) {
        // Ignore 404s on deletion
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
            return true;
        }
        log.error(`Errore eliminazione ${fileName}`, err);
        return false;
    }
}

/**
 * Downloads a file from the Oracle bucket into the local directory.
 */
export async function downloadFromOracle(fileName: string, localPath: string, sessionId?: string): Promise<boolean> {
    try {
        const key = await findS3Key(fileName, sessionId);
        if (!key) {
            log.error(`File non trovato nel Cloud (né in sessione né legacy): ${fileName}`);
            return false;
        }

        const command = new GetObjectCommand({
            Bucket: getBucketName(),
            Key: key,
        });

        const response = await withRetry(() => getS3Client().send(command), 3, 1000, `download ${key}`);

        if (response.Body) {
            // Make sure the directory exists
            const dir = path.dirname(localPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const stream = response.Body as Readable;
            const fileStream = fs.createWriteStream(localPath);

            return new Promise((resolve, reject) => {
                const cleanup = () => {
                    try { stream.destroy(); } catch {}
                    try { fileStream.destroy(); } catch {}
                };

                stream.on('error', (err) => {
                    log.error(`Errore lettura stream S3 ${fileName}`, err);
                    cleanup();
                    reject(err);
                });

                fileStream.on('error', (err) => {
                    log.error(`Errore scrittura file locale ${fileName}`, err);
                    cleanup();
                    // Remove partially written file
                    try { fs.unlinkSync(localPath); } catch {}
                    reject(err);
                });

                stream.pipe(fileStream)
                    .on('finish', () => {
                        log.info(`File ripristinato da Oracle: ${fileName}`);
                        resolve(true);
                    });
            });
        }
        return false;
    } catch (err: any) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
            log.error(`File non trovato nel Cloud: ${fileName}`);
        } else {
            log.error(`Errore download da Oracle per ${fileName}`, err);
        }
        return false;
    }
}

/**
 * Generates a signed URL (Pre-Authenticated Request) to download a file.
 * The URL expires after the given time (default 1 hour).
 */
export async function getPresignedUrl(
    fileNameOrKey: string,
    sessionId?: string,
    expiresInSeconds: number = 3600
): Promise<string | null> {
    try {
        let key: string | null = null;

        // ✅ When it contains '/', treat it as a full key
        if (fileNameOrKey.includes('/')) {
            // Check whether it really exists using the full key
            try {
                await getS3Client().send(new HeadObjectCommand({ Bucket: getBucketName(), Key: fileNameOrKey }));
                key = fileNameOrKey;
            } catch (err: any) {
                if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
                    // Not found, return null so the caller knows it has to be regenerated
                    return null;
                }
                // Other errors: log and return null
                log.error(`Errore verifica chiave custom ${fileNameOrKey}`, err);
                return null;
            }
        } else {
            // Comportamento legacy
            key = await findS3Key(fileNameOrKey, sessionId);

            if (!key) {
                // When not found, we could try building the target key (maybe it does not exist yet but we want the URL for an upload?)
                // No: getPresignedUrl for download (GetObject) requires the object to exist, or the download will 404.
                // So when findS3Key fails, we return null.
                return null;
            }
        }

        const command = new GetObjectCommand({
            Bucket: getBucketName(),
            Key: key
        });

        const url = await getSignedUrl(getS3Client(), command, { expiresIn: expiresInSeconds });
        log.info(`URL generato per ${key} (valido ${expiresInSeconds}s)`);
        return url;

    } catch (err) {
        log.error(`Errore URL firmato per ${fileNameOrKey}`, err as Error);
        return null;
    }
}

/**
 * Checks the space used across every OCI bucket and compares it with the Free Tier (10GB).
 */
export interface StorageStats {
    totalBytes: number;
    totalGB: number;
    freeTierLimitGB: number;
    percentUsed: number;
    bucketCount: number;
    ok: boolean;
}

/**
 * Checks the space used across every OCI bucket and compares it with the Free Tier (10GB).
 * Returns the statistics for programmatic use.
 */
export async function checkStorageUsage(silent: boolean = false): Promise<StorageStats> {
    try {
        const client = getS3Client();
        const bucketsResponse = await client.send(new ListBucketsCommand({}));

        let totalBytes = 0;
        let bucketCount = 0;
        const bucketDetails: string[] = [];

        if (bucketsResponse.Buckets) {
            for (const bucket of bucketsResponse.Buckets) {
                const bucketName = bucket.Name;
                if (!bucketName) continue;

                bucketCount++;
                let bucketBytes = 0;
                let continuationToken: string | undefined = undefined;

                do {
                    const listCmd: ListObjectsV2Command = new ListObjectsV2Command({
                        Bucket: bucketName,
                        ContinuationToken: continuationToken
                    });

                    const response: ListObjectsV2CommandOutput = await client.send(listCmd);

                    if (response.Contents) {
                        for (const obj of response.Contents) {
                            bucketBytes += obj.Size || 0;
                        }
                    }

                    continuationToken = response.NextContinuationToken;
                } while (continuationToken);

                totalBytes += bucketBytes;
                const bucketGB = bucketBytes / (1024 * 1024 * 1024);
                bucketDetails.push(`   - ${bucketName}: ${bucketGB.toFixed(2)} GB`);
            }
        }

        const totalGB = totalBytes / (1024 * 1024 * 1024);
        const freeTierLimit = 10.0; // 10 GB Free Tier
        const percentUsed = (totalGB / freeTierLimit) * 100;

        if (!silent) {
            // Log colour by percentage
            let icon = '🟢';
            if (percentUsed > 75) icon = '🟡';
            if (percentUsed > 90) icon = '🔴';

            console.log(`[Oracle] ${icon} Storage Usage (${bucketCount} buckets): ${totalGB.toFixed(2)} GB / ${freeTierLimit.toFixed(2)} GB (${percentUsed.toFixed(1)}%)`);
            if (bucketDetails.length > 0) {
                console.log(bucketDetails.join('\n'));
            }
        }

        return {
            totalBytes,
            totalGB,
            freeTierLimitGB: freeTierLimit,
            percentUsed,
            bucketCount,
            ok: true
        };

    } catch (err: any) {
        log.error(`Errore controllo spazio storage: ${err.message}`);
        // Stats zeroed but ok:false — the caller has to tell "empty storage" from "check failed"
        return { totalBytes: 0, totalGB: 0, freeTierLimitGB: 10, percentUsed: 0, bucketCount: 0, ok: false };
    }
}

/**
 * Deletes the RAW (.flac) files of a specific session to save space.
 * It preserves the .mp3 (Master/Live) and .json (transcripts) files.
 */
export async function deleteRawSessionFiles(sessionId: string): Promise<number> {
    const client = getS3Client();
    const bucket = getBucketName();
    let deletedCount = 0;

    // Build list of prefixes to scan (tenant path + legacy path)
    const prefixes: string[] = [];
    const guildId = resolveGuildId(sessionId);
    if (guildId) {
        prefixes.push(`recordings/${guildId}/${sessionId}/`);
    }
    prefixes.push(`recordings/${sessionId}/`);

    log.info(`Pulizia file RAW per sessione ${sessionId}...`);

    try {
        for (const prefix of prefixes) {
            let continuationToken: string | undefined = undefined;
            do {
                const listCmd: ListObjectsV2Command = new ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: prefix,
                    ContinuationToken: continuationToken
                });

                const response: ListObjectsV2CommandOutput = await client.send(listCmd);

                if (response.Contents && response.Contents.length > 0) {
                    const objectsToDelete = response.Contents
                        .filter(obj => obj.Key && obj.Key.endsWith('.flac')) // FLAC only
                        .map(obj => ({ Key: obj.Key! }));

                    if (objectsToDelete.length > 0) {
                        for (let i = 0; i < objectsToDelete.length; i += 1000) {
                            const batch = objectsToDelete.slice(i, i + 1000);
                            await Promise.all(batch.map(obj => client.send(new DeleteObjectCommand({
                                Bucket: bucket,
                                Key: obj.Key
                            }))));
                            deletedCount += batch.length;
                        }
                    }
                }
                continuationToken = response.NextContinuationToken;
            } while (continuationToken);
        }

        log.info(`Eliminati ${deletedCount} file RAW (.flac) per sessione ${sessionId}.`);
        return deletedCount;

    } catch (err: any) {
        log.error(`Errore pulizia RAW sessione ${sessionId}`, err);
        return 0;
    }
}

/**
 * Deletes every object under a prefix, optionally filtered.
 *
 * The generic counterpart of {@link deleteRawSessionFiles}: erasing a guild or a
 * campaign has to sweep several prefixes whose layout is not uniform (raw audio
 * is under `recordings/{guildId}/{sessionId}/`, masters and transcripts only
 * under `recordings/{sessionId}/` and `transcripts/{sessionId}/`), and each of
 * them would otherwise grow its own copy of this loop.
 *
 * `keep` lets a caller spare part of the prefix — retention passes the object's
 * age, erasure passes nothing and takes everything.
 *
 * Note: Oracle Object Storage rejects DeleteObjectsCommand (bulk) with
 * "Missing required header for this request: Content-MD5 ...", so objects are
 * deleted one at a time with limited concurrency.
 */
export async function deleteByPrefix(
    prefix: string,
    keep?: (key: string, lastModified?: Date) => boolean,
): Promise<number> {
    const client = getS3Client();
    const bucket = getBucketName();
    const CONCURRENCY = 25;
    let deletedCount = 0;

    try {
        let continuationToken: string | undefined = undefined;
        do {
            const listCmd: ListObjectsV2Command = new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken,
            });

            const response: ListObjectsV2CommandOutput = await client.send(listCmd);
            const keys = (response.Contents || [])
                .filter(obj => !!obj.Key)
                .filter(obj => !keep || !keep(obj.Key!, obj.LastModified))
                .map(obj => obj.Key!);

            for (let i = 0; i < keys.length; i += CONCURRENCY) {
                const batch = keys.slice(i, i + CONCURRENCY);
                await Promise.all(batch.map(key => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))));
                deletedCount += batch.length;
            }

            continuationToken = response.NextContinuationToken;
        } while (continuationToken);

        return deletedCount;
    } catch (err: any) {
        // The caller decides what a partial failure means: erasure has to report
        // it (data survives), retention can shrug and retry tomorrow.
        log.error(`Error deleting objects under ${prefix}`, err);
        throw err;
    }
}

/**
 * Deletes the files left orphaned in transcription_temp/ (temporary FLAC uploads
 * used to generate the presigned URL for the remote PC). They are normally
 * deleted right after use by scriba.ts, but a process crash before the
 * cleanup leaves them there forever: no other component touches them.
 *
 * Note: Oracle Object Storage rejects DeleteObjectsCommand (bulk) with
 * "Missing required header for this request: Content-MD5 ...", so files are
 * deleted one at a time with limited concurrency.
 */
export async function deleteStaleTranscriptionTempFiles(maxAgeHours: number): Promise<number> {
    const client = getS3Client();
    const bucket = getBucketName();
    const prefix = 'transcription_temp/';
    const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
    const CONCURRENCY = 25;
    let deletedCount = 0;

    try {
        let continuationToken: string | undefined = undefined;
        do {
            const listCmd: ListObjectsV2Command = new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken
            });

            const response: ListObjectsV2CommandOutput = await client.send(listCmd);
            const staleKeys = (response.Contents || [])
                .filter(obj => obj.Key && obj.LastModified && obj.LastModified.getTime() < cutoff)
                .map(obj => obj.Key!);

            for (let i = 0; i < staleKeys.length; i += CONCURRENCY) {
                const batch = staleKeys.slice(i, i + CONCURRENCY);
                await Promise.all(batch.map(key => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))));
                deletedCount += batch.length;
            }

            continuationToken = response.NextContinuationToken;
        } while (continuationToken);

        if (deletedCount > 0) {
            console.log(`[Custode] 🧹 Eliminati ${deletedCount} file orfani in transcription_temp/ (più vecchi di ${maxAgeHours}h).`);
        }
        return deletedCount;

    } catch (err: any) {
        console.error(`[Custode] ❌ Errore pulizia transcription_temp/:`, err);
        return deletedCount;
    }
}
