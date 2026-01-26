
process.env.DISCORD_BOT_TOKEN = 'mock-token';
process.env.DISCORD_CLIENT_ID = 'mock-client-id';
process.env.DISCORD_GUILD_ID = 'mock-guild-id';
process.env.OPENAI_API_KEY = 'mock-key';

import { db } from '../../../src/db/client';

// Mock DB
jest.mock('../../../src/db/client', () => {
    const Database = require('better-sqlite3');
    const mockDb = new Database(':memory:');

    mockDb.exec(`
        CREATE TABLE campaigns (id INTEGER PRIMARY KEY, guild_id TEXT, is_active INTEGER);
        CREATE TABLE sessions (session_id TEXT PRIMARY KEY, campaign_id INTEGER, session_number INTEGER);
        CREATE TABLE npc_dossier (
            id INTEGER PRIMARY KEY, 
            campaign_id INTEGER, 
            name TEXT, 
            description TEXT, 
            is_manual INTEGER DEFAULT 0,
            UNIQUE(campaign_id, name)
        );
        CREATE TABLE location_atlas (
            id INTEGER PRIMARY KEY, 
            campaign_id INTEGER, 
            macro_location TEXT, 
            micro_location TEXT, 
            description TEXT, 
            is_manual INTEGER DEFAULT 0,
            UNIQUE(campaign_id, macro_location, micro_location)
        );
        CREATE TABLE npc_history (
            id INTEGER PRIMARY KEY, 
            campaign_id INTEGER, 
            npc_name TEXT, 
            description TEXT,
            is_manual INTEGER DEFAULT 0
        );
        CREATE TABLE location_history (
            id INTEGER PRIMARY KEY, 
            campaign_id INTEGER, 
            macro_location TEXT, 
            micro_location TEXT,
            is_manual INTEGER DEFAULT 0
        );
        CREATE TABLE atlas_history (
            id INTEGER PRIMARY KEY, 
            campaign_id INTEGER, 
            macro_location TEXT, 
            micro_location TEXT,
            description TEXT,
            is_manual INTEGER DEFAULT 0
        );
    `);

    return {
        db: mockDb,
        getSessionCampaignId: jest.fn()
    };
});

// Mock monitor and other dependencies of rebuild.ts
jest.mock('../../../src/monitor', () => ({
    monitor: { startSession: jest.fn(), endSession: jest.fn(), logError: jest.fn() }
}));
jest.mock('../../../src/reporter', () => ({ processSessionReport: jest.fn() }));
jest.mock('../../../src/publisher/services/PipelineService');
jest.mock('../../../src/publisher/services/IngestionService');
jest.mock('bullmq', () => ({
    Queue: jest.fn().mockImplementation(() => ({
        add: jest.fn(),
        on: jest.fn(),
        close: jest.fn(),
    })),
    Worker: jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        close: jest.fn(),
    })),
}));
jest.mock('ioredis');

import { pruneEmptyEntities } from '../../../src/commands/admin/rebuild';

describe('Rebuild Command - Pruning', () => {
    let mockDb: any;

    beforeAll(() => {
        mockDb = db;
    });

    beforeEach(() => {
        mockDb.prepare('DELETE FROM npc_dossier').run();
        mockDb.prepare('DELETE FROM location_atlas').run();
        mockDb.prepare('DELETE FROM npc_history').run();
        mockDb.prepare('DELETE FROM location_history').run();
        mockDb.prepare('DELETE FROM atlas_history').run();
    });

    it('should prune history when entities are pruned (zombie entries)', () => {
        // Setup state:
        // 1. A "zombie" NPC (no description) with history
        mockDb.prepare("INSERT INTO npc_dossier (campaign_id, name, description, is_manual) VALUES (1, 'ZombieNPC', NULL, 0)").run();
        mockDb.prepare("INSERT INTO npc_history (campaign_id, npc_name, description) VALUES (1, 'ZombieNPC', 'Some event')").run();

        // 2. A "valid" NPC with history
        mockDb.prepare("INSERT INTO npc_dossier (campaign_id, name, description, is_manual) VALUES (1, 'ValidNPC', 'A brave hero', 0)").run();
        mockDb.prepare("INSERT INTO npc_history (campaign_id, npc_name, description) VALUES (1, 'ValidNPC', 'Heroic deed')").run();

        // 3. A "zombie" Location with history
        mockDb.prepare("INSERT INTO location_atlas (campaign_id, macro_location, micro_location, description, is_manual) VALUES (1, 'ZombieRegion', 'ZombiePlace', NULL, 0)").run();
        mockDb.prepare("INSERT INTO location_history (campaign_id, macro_location, micro_location) VALUES (1, 'ZombieRegion', 'ZombiePlace')").run();
        mockDb.prepare("INSERT INTO atlas_history (campaign_id, macro_location, micro_location, description) VALUES (1, 'ZombieRegion', 'ZombiePlace', 'Seen once')").run();

        // 4. A "valid" Location with history
        mockDb.prepare("INSERT INTO location_atlas (campaign_id, macro_location, micro_location, description, is_manual) VALUES (1, 'ValidRegion', 'ValidPlace', 'A beautiful city', 0)").run();
        mockDb.prepare("INSERT INTO location_history (campaign_id, macro_location, micro_location) VALUES (1, 'ValidRegion', 'ValidPlace')").run();
        mockDb.prepare("INSERT INTO atlas_history (campaign_id, macro_location, micro_location, description) VALUES (1, 'ValidRegion', 'ValidPlace', 'Visited')").run();

        // Execute pruning
        const result = pruneEmptyEntities();

        // Assertions
        expect(result.npcs).toBe(1);
        expect(result.locations).toBe(1);

        // Verify NPC stuff
        const npcDossier = mockDb.prepare("SELECT name FROM npc_dossier").all();
        expect(npcDossier.map((n: any) => n.name)).toContain('ValidNPC');
        expect(npcDossier.map((n: any) => n.name)).not.toContain('ZombieNPC');

        const npcHistory = mockDb.prepare("SELECT npc_name FROM npc_history").all();
        expect(npcHistory.map((n: any) => n.npc_name)).toContain('ValidNPC');
        expect(npcHistory.map((n: any) => n.npc_name)).not.toContain('ZombieNPC');

        // Verify Location stuff
        const locationAtlas = mockDb.prepare("SELECT macro_location FROM location_atlas").all();
        expect(locationAtlas.map((l: any) => l.macro_location)).toContain('ValidRegion');
        expect(locationAtlas.map((l: any) => l.macro_location)).not.toContain('ZombieRegion');

        const locationHistory = mockDb.prepare("SELECT macro_location FROM location_history").all();
        expect(locationHistory.map((l: any) => l.macro_location)).toContain('ValidRegion');
        expect(locationHistory.map((l: any) => l.macro_location)).not.toContain('ZombieRegion');

        const atlasHistory = mockDb.prepare("SELECT macro_location FROM atlas_history").all();
        expect(atlasHistory.map((l: any) => l.macro_location)).toContain('ValidRegion');
        expect(atlasHistory.map((l: any) => l.macro_location)).not.toContain('ZombieRegion');
    });

    it('should NOT prune manual entries even if description is empty', () => {
        // Setup state:
        // 1. A manual NPC with no description
        mockDb.prepare("INSERT INTO npc_dossier (campaign_id, name, description, is_manual) VALUES (1, 'ManualNPC', NULL, 1)").run();
        mockDb.prepare("INSERT INTO npc_history (campaign_id, npc_name, description) VALUES (1, 'ManualNPC', 'Manually created')").run();

        // 2. A manual Location with no description
        mockDb.prepare("INSERT INTO location_atlas (campaign_id, macro_location, micro_location, description, is_manual) VALUES (1, 'ManualRegion', 'ManualPlace', NULL, 1)").run();
        mockDb.prepare("INSERT INTO location_history (campaign_id, macro_location, micro_location) VALUES (1, 'ManualRegion', 'ManualPlace')").run();

        // Execute pruning
        const result = pruneEmptyEntities();

        // Assertions
        expect(result.npcs).toBe(0);
        expect(result.locations).toBe(0);

        // Verify entries still exist
        const npcDossier = mockDb.prepare("SELECT name FROM npc_dossier WHERE name = 'ManualNPC'").get();
        expect(npcDossier).toBeDefined();

        const locAtlas = mockDb.prepare("SELECT macro_location FROM location_atlas WHERE macro_location = 'ManualRegion'").get();
        expect(locAtlas).toBeDefined();
    });
});
