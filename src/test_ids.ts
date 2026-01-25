
import { db } from './db';
import { npcCommand } from './commands/npcs/npc';
import { atlasCommand } from './commands/locations/atlas';

// Mock Ctx
const mockCtx: any = {
    guildId: 'test_guild',
    activeCampaign: { id: 1, name: 'Test Campaign' },
    args: [],
    message: {
        reply: async (msg: string | any) => console.log(`[BOT]`, typeof msg === 'string' ? msg : msg.content || JSON.stringify(msg))
    }
};

async function runTest() {
    // Setup
    db.prepare("INSERT OR IGNORE INTO campaigns (id, guild_id, name) VALUES (1, 'test_guild', 'Test Campaign')").run();
    db.prepare("INSERT OR IGNORE INTO npc_dossier (id, campaign_id, name, role, status) VALUES (99, 1, 'Garlon', 'Merchant', 'ALIVE')").run();
    db.prepare("INSERT OR IGNORE INTO location_atlas (id, campaign_id, macro_location, micro_location) VALUES (99, 1, 'Wildlands', 'Ruins')").run();

    console.log("--- TEST NPC IDs ---");
    // List
    console.log("> LIST");
    mockCtx.args = ['list'];
    await npcCommand.execute(mockCtx);

    // Update by ID (ID 1 since it's first in list probably)
    console.log("> UPDATE ID 1");
    mockCtx.args = ['update', '1', '|', 'He sold us fake potions.'];
    await npcCommand.execute(mockCtx);

    console.log("--- TEST ATLAS IDs ---");
    // List
    console.log("> LIST");
    mockCtx.args = ['list'];
    await atlasCommand.execute(mockCtx);

    // Update by ID
    console.log("> UPDATE ID 1 (Atlas)");
    mockCtx.args = ['update', '1', '|', 'The ruins are haunted.'];
    await atlasCommand.execute(mockCtx);

    // View by ID
    console.log("> VIEW ID 1 (Atlas)");
    mockCtx.args = ['1'];
    await atlasCommand.execute(mockCtx);
}

runTest().catch(console.error);
