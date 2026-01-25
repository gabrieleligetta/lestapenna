
import { db } from './db';
import { npcCommand } from './commands/npcs/npc';
import { atlasCommand } from './commands/locations/atlas';
import { questCommand } from './commands/inventory/quest';
import { inventoryCommand } from './commands/inventory/inventory';
import { bestiaryCommand } from './commands/inventory/bestiary';

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
    // Ensure DB entries
    db.prepare("INSERT OR IGNORE INTO campaigns (id, guild_id, name) VALUES (1, 'test_guild', 'Test Campaign')").run();
    db.prepare("INSERT OR IGNORE INTO npc_dossier (id, campaign_id, name, role, status) VALUES (99, 1, 'Garlon', 'Merchant', 'ALIVE')").run();
    db.prepare("INSERT OR IGNORE INTO location_atlas (id, campaign_id, macro_location, micro_location) VALUES (99, 1, 'Wildlands', 'Ruins')").run();
    // Quest/Inventory/Bestiary setup
    // ... assumed existing or we rely on commands adding them?

    console.log("--- TEST NPC IDs ---");
    mockCtx.args = ['list'];
    await npcCommand.execute(mockCtx);

    mockCtx.args = ['update', '1', '|', 'Test Note'];
    await npcCommand.execute(mockCtx);

    console.log("\n--- TEST ATLAS IDs ---");
    mockCtx.args = ['list'];
    await atlasCommand.execute(mockCtx);

    mockCtx.args = ['update', '1', '|', 'Test Note'];
    await atlasCommand.execute(mockCtx);

    console.log("\n--- TEST QUEST IDs ---");
    // Add quest first
    mockCtx.args = ['add', 'Find the Gem'];
    await questCommand.execute(mockCtx);

    mockCtx.args = []; // List
    await questCommand.execute(mockCtx);

    mockCtx.args = ['update', '1', '|', 'Found it!'];
    await questCommand.execute(mockCtx);

    console.log("\n--- TEST INVENTORY IDs ---");
    mockCtx.args = ['add', 'Gem'];
    await inventoryCommand.execute(mockCtx);

    mockCtx.args = []; // List
    await inventoryCommand.execute(mockCtx);

    mockCtx.args = ['update', '1', '|', 'Shiny'];
    await inventoryCommand.execute(mockCtx);

    console.log("\n--- TEST BESTIARY IDs ---");
    // Must add manually as `add` command not exposed yet or implicit
    db.prepare("INSERT OR IGNORE INTO bestiary (campaign_id, name, status) VALUES (1, 'Dragon', 'ALIVE')").run();

    mockCtx.args = []; // List
    await bestiaryCommand.execute(mockCtx);

    mockCtx.args = ['update', '1', '|', 'Roars loudly'];
    await bestiaryCommand.execute(mockCtx);
}

runTest().catch(console.error);
