import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
    const actual = jest.requireActual('@aws-sdk/client-s3');
    return {
        ...actual,
        S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
    };
});

import {
    uploadToOracle,
    deleteFromOracle,
    checkStorageUsage,
    cloudObjectExists,
} from '../../../src/services/backup';

describe('backup.ts — retry su errori transitori', () => {
    beforeEach(() => {
        mockSend.mockReset();
    });

    it('uploadToOracle retries after a transient failure and then succeeds', async () => {
        mockSend
            .mockRejectedValueOnce(new Error('network blip'))
            .mockResolvedValueOnce({});

        const tmpFile = path.join(os.tmpdir(), 'retry-upload-test.flac');
        fs.writeFileSync(tmpFile, Buffer.alloc(8));

        try {
            // customKey skips findS3Key's HeadObjectCommand checks: it isolates the test
            // on the single PutObjectCommand call wrapped by withRetry.
            const result = await uploadToOracle(tmpFile, 'retry-upload-test.flac', undefined, 'custom/retry-upload-test.flac');
            expect(result).toBe('retry-upload-test.flac');
            expect(mockSend).toHaveBeenCalledTimes(2);
        } finally {
            fs.unlinkSync(tmpFile);
        }
    }, 10000);

    it('deleteFromOracle keeps the existing behaviour when every attempt fails', async () => {
        mockSend.mockRejectedValue(new Error('persistent failure'));

        const result = await deleteFromOracle('does-not-matter.flac', 'session-x');
        expect(result).toBe(false);
    }, 15000);

    it('checkStorageUsage reports ok:false rather than implying the storage is empty', async () => {
        mockSend.mockRejectedValueOnce(new Error('ListBuckets down'));

        const stats = await checkStorageUsage(true);
        expect(stats.ok).toBe(false);
        expect(stats.totalGB).toBe(0);
    });

    it('checkStorageUsage segnala ok:true su successo', async () => {
        mockSend.mockResolvedValueOnce({ Buckets: [] });

        const stats = await checkStorageUsage(true);
        expect(stats.ok).toBe(true);
    });

    it('cloudObjectExists checks a full key without generating a URL', async () => {
        mockSend.mockResolvedValueOnce({});
        await expect(cloudObjectExists('recordings/session/master.mp3')).resolves.toBe(true);

        mockSend.mockRejectedValueOnce({ name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        await expect(cloudObjectExists('recordings/session/missing.mp3')).resolves.toBe(false);
    });

});
