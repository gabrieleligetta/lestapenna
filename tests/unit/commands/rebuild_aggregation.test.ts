
process.env.DISCORD_BOT_TOKEN = 'mock-token';
process.env.DISCORD_CLIENT_ID = 'mock-client-id';
process.env.DISCORD_GUILD_ID = 'mock-guild-id';
process.env.OPENAI_API_KEY = 'mock-key';

import { sendTechnicalReport } from '../../../src/commands/admin/rebuild';
import * as fs from 'fs';
import * as path from 'path';

// Mock FS first
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

// Mock Side-Effect Modules (Prevent DB/Redis connections)
jest.mock('../../../src/db/client', () => ({
    db: { prepare: jest.fn(() => ({ get: jest.fn(), run: jest.fn(), all: jest.fn() })) },
    getSessionCampaignId: jest.fn()
}));
jest.mock('../../../src/services/queue', () => ({
    audioQueue: { add: jest.fn(), pause: jest.fn(), resume: jest.fn() }
}));
jest.mock('../../../src/workers', () => ({
    unloadTranscriptionModels: jest.fn()
}));

// Mock Modules
jest.mock('../../../src/db', () => ({
    db: { prepare: jest.fn() },
    getSessionCampaignId: jest.fn()
}));
jest.mock('../../../src/monitor', () => ({
    monitor: {
        endSession: jest.fn().mockResolvedValue({ errors: [] }),
        logError: jest.fn()
    }
}));
jest.mock('../../../src/publisher/services/PipelineService');
jest.mock('../../../src/publisher/services/IngestionService');
jest.mock('../../../src/reporter', () => ({
    processSessionReport: jest.fn()
}));

describe('Rebuild Command - Aggregation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should copy debug files from processed sessions', async () => {
        const rebuildId = 'rebuild-test-123';
        const sessions = [
            { session_id: 'session-A', campaign_id: 1, start_time: 0, title: 'Title A', session_number: 1 },
            { session_id: 'session-B', campaign_id: 1, start_time: 0, title: 'Title B', session_number: 2 }
        ];

        // Mock FS behavior
        mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
            const pStr = p.toString();
            if (pStr.includes('session-A/debug_prompts')) return true;
            if (pStr.includes('session-B/debug_prompts')) return false; // Session B has no debug files
            if (pStr.includes(rebuildId)) return false; // Rebuild dir doesn't exist yet
            return false;
        });

        mockFs.readdirSync.mockImplementation((p: fs.PathLike) => {
            const pStr = p.toString();
            if (pStr.includes('session-A/debug_prompts')) return ['prompt.txt', 'response.json', 'ignore.bin'] as any;
            return [] as any;
        });

        mockFs.statSync.mockImplementation((p: fs.PathLike) => ({ isDirectory: () => true }) as any);

        await sendTechnicalReport(rebuildId, sessions as any, 1, 1, 0, []);

        // Verify mkdir for rebuild session was called
        expect(mockFs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining(rebuildId), { recursive: true });

        // Verify copyFileSync was called for session-A files only
        // Should copy 'prompt.txt' and 'response.json'
        // Should NOT copy 'ignore.bin' (filtered by extension in code)
        expect(mockFs.copyFileSync).toHaveBeenCalledTimes(2);

        // Check first copy
        const calls = mockFs.copyFileSync.mock.calls;
        const destPaths = calls.map(c => c[1].toString());

        expect(destPaths.some(p => p.endsWith('session-A_prompt.txt'))).toBe(true);
        expect(destPaths.some(p => p.endsWith('session-A_response.json'))).toBe(true);
    });

    it('should handle missing debug directories gracefully', async () => {
        const rebuildId = 'rebuild-test-456';
        const sessions = [
            { session_id: 'session-C', campaign_id: 1, start_time: 0, title: 'Title C', session_number: 1 }
        ];

        mockFs.existsSync.mockReturnValue(false); // Nothing exists

        await sendTechnicalReport(rebuildId, sessions as any, 1, 1, 0, []);

        expect(mockFs.copyFileSync).not.toHaveBeenCalled();
        // Should not throw
    });
});
