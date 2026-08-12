import * as fs from 'fs';
import * as path from 'path';

// Mock ffmpeg: creates a placeholder file at the output path (the second-to-last argument, by
// convention the last is always '-y' in this codebase) and resolves successfully right away.
jest.mock('child_process', () => {
    const { EventEmitter } = require('events');
    const fsMock = require('fs');
    return {
        spawn: jest.fn().mockImplementation((_cmd: string, args: string[]) => {
            const proc: any = new EventEmitter();
            proc.stderr = new EventEmitter();
            proc.kill = jest.fn();
            const outputPath = args[args.length - 2];
            setImmediate(() => {
                try { fsMock.writeFileSync(outputPath, Buffer.alloc(16)); } catch { }
                proc.emit('close', 0);
            });
            return proc;
        }),
    };
});

const mockDbRun = jest.fn();
jest.mock('../../../src/db', () => ({
    getSessionRecordings: jest.fn(),
}));
jest.mock('../../../src/db/client', () => ({
    db: { prepare: jest.fn(() => ({ run: mockDbRun })) },
}));
jest.mock('../../../src/services/backup', () => ({
    downloadFromOracle: jest.fn().mockResolvedValue(false),
    uploadToOracle: jest.fn().mockResolvedValue('ok'),
    deleteFromOracle: jest.fn(),
    getPresignedUrl: jest.fn(),
}));

import { mixSessionAudio } from '../../../src/services/sessionMixer';
import { getSessionRecordings } from '../../../src/db';

const RECORDINGS_DIR = path.join(__dirname, '../../../src/recordings');

describe('sessionMixer — audio loss is no longer silent', () => {
    const sessionId = 'test-session-mix';
    const validFile = `valid-${sessionId}.flac`;
    const corruptFile = `corrupt-${sessionId}.flac`;
    const missingFile = `missing-${sessionId}.flac`;

    beforeAll(() => {
        if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
        fs.writeFileSync(path.join(RECORDINGS_DIR, validFile), Buffer.alloc(2048, 1)); // >1024 bytes: valido
        fs.writeFileSync(path.join(RECORDINGS_DIR, corruptFile), Buffer.alloc(10, 1)); // <1024 bytes: corrotto
        // missingFile: nessun file locale creato, e downloadFromOracle è mockato per fallire
    });

    afterAll(() => {
        for (const f of [validFile, corruptFile]) {
            try { fs.unlinkSync(path.join(RECORDINGS_DIR, f)); } catch { }
        }
    });

    beforeEach(() => {
        mockDbRun.mockClear();
    });

    it('does not abort the mix over missing or corrupt files, and persists the warning to the DB', async () => {
        (getSessionRecordings as jest.Mock).mockReturnValue([
            { filename: validFile, timestamp: 1000 },
            { filename: corruptFile, timestamp: 2000 },
            { filename: missingFile, timestamp: 3000 },
        ]);

        const result = await mixSessionAudio(sessionId, true);
        expect(result).toContain(sessionId);

        expect(mockDbRun).toHaveBeenCalledTimes(1);
        const [warningJson, dbSessionId] = mockDbRun.mock.calls[0];
        expect(dbSessionId).toBe(sessionId);

        const skipped = JSON.parse(warningJson);
        const byFilename = Object.fromEntries(skipped.map((s: any) => [s.filename, s.reason]));
        expect(byFilename[missingFile]).toBe('missing');
        expect(byFilename[corruptFile]).toBe('corrupt');
        expect(Object.keys(byFilename)).not.toContain(validFile);
    });

    it('writes no warning when every file is valid', async () => {
        (getSessionRecordings as jest.Mock).mockReturnValue([
            { filename: validFile, timestamp: 1000 },
        ]);

        await mixSessionAudio(sessionId, true);
        expect(mockDbRun).not.toHaveBeenCalled();
    });
});
