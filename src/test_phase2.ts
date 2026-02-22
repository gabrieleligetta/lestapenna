
import { db } from './db';
import { questCommand } from './commands/inventory/quest';
import { bestiaryCommand } from './commands/inventory/bestiary';
import { inventoryCommand } from './commands/inventory/inventory';
import { generateBio } from './bard/bio';
import { setActiveSession } from './state/sessionState';

// Mock Metadata Client (Stub to avoid API calls or allow them if configured?)
// We rely on actual calls if credentials exist, or failure if not.

const mockCtx: any = {
    guildId: 'test_guild',
    user: { id: 'test_user', username: 'Tester' },
    activeCampaign: { id: 1, name: 'Test Campaign' },
    args: [],
    message: {
        reply: async (msg: string) => console.log(`[BOT] ${msg}`)
    }
};

async function runTest() {
    console.log("=== STARTING PHASE 2 TEST ===");

    // 1. Setup
    try {
        db.prepare("INSERT OR IGNORE INTO campaigns (id, guild_id, name) VALUES (1, 'test_guild', 'Test Campaign')").run();
        await setActiveSession('test_guild', 'test_session_1');
    } catch (e) { console.error("Setup error", e); }

    // 2. QUEST TEST
    console.log("\n--- TESTING QUEST ---");
    // Add Quest
    mockCtx.args = ['add', 'The Lost Relic'];
    await questCommand.execute(mockCtx);

    // Update Quest
    mockCtx.args = ['update', 'The Lost Relic', '|', 'We found a map leading to the swamp.'];
    await questCommand.execute(mockCtx);

    // View Quest
    mockCtx.args = [];
    await questCommand.execute(mockCtx);

    // 3. INVENTORY TEST
    console.log("\n--- TESTING INVENTORY ---");
    // Add Item
    mockCtx.args = ['add', 'Strange Map'];
    await inventoryCommand.execute(mockCtx);

    // Update Item
    mockCtx.args = ['update', 'Strange Map', '|', 'The map glows in the dark.'];
    await inventoryCommand.execute(mockCtx);

    // View Inventory
    mockCtx.args = [];
    await inventoryCommand.execute(mockCtx);

    // 4. BESTIARY TEST
    console.log("\n--- TESTING BESTIARY ---");
    // Manual Update (Simulate manual entry since no Add command)
    db.prepare("INSERT OR IGNORE INTO bestiary (campaign_id, name, status, session_id) VALUES (1, 'Swamp Golem', 'ALIVE', 'test_session_1')").run();

    // Update Monster
    mockCtx.args = ['update', 'Swamp Golem', '|', 'It is made of mud and vines. Weak to fire?'];
    await bestiaryCommand.execute(mockCtx);

    // View Bestiary
    mockCtx.args = ['Swamp Golem'];
    await bestiaryCommand.execute(mockCtx);

    console.log("\n=== TEST COMPLETED ===");
}

runTest().catch(console.error);
