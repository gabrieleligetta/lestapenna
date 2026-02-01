
import { db } from '../src/db/client';
import { npcRepository } from '../src/db/repositories/NpcRepository';

const TEST_NPC = 'Testus Manualis';
const MANUAL_DESC = 'Questa è la descrizione manuale originale dell\'utente.';
const AI_DESC = 'Questa è una descrizione generata dall\'AI.';

async function runTest() {
    console.log("🧪 Starting Verification Test for Manual Description Backup...");

    const campaignId = 1; // Assuming campaign 1 exists or is irrelevant for this unit test logic if constraints aren't strict

    // 0. Cleanup
    db.prepare('DELETE FROM npc_dossier WHERE name = ?').run(TEST_NPC);

    // 1. User Update (Manual)
    console.log("\n🔹 Step 1: User creates Manual Description");
    npcRepository.updateNpcEntry(campaignId, TEST_NPC, MANUAL_DESC, 'Tester', 'ALIVE', 'session-1', true);

    let npc = npcRepository.getNpcEntry(campaignId, TEST_NPC) as any;
    console.log(`[Check] is_manual: ${npc.is_manual} (Expected: 1)`);
    console.log(`[Check] specific description: "${npc.description}"`);
    console.log(`[Check] manual_description: "${npc.manual_description}" (Expected: match)`);

    if (npc.is_manual !== 1 || npc.manual_description !== MANUAL_DESC) {
        console.error("❌ Step 1 Failed!");
        return;
    }

    // 2. AI Update (Sync)
    console.log("\n🔹 Step 2: AI Updates Description (should preserve backup)");
    npcRepository.updateNpcEntry(campaignId, TEST_NPC, AI_DESC, 'Tester', 'ALIVE', 'session-1', false);

    npc = npcRepository.getNpcEntry(campaignId, TEST_NPC) as any;
    console.log(`[Check] is_manual: ${npc.is_manual} (Expected: 0)`);
    console.log(`[Check] specific description: "${npc.description}" (Expected: AI Desc)`);
    console.log(`[Check] manual_description: "${npc.manual_description}" (Expected: Original Manual)`);

    if (npc.is_manual !== 0 || npc.description !== AI_DESC || npc.manual_description !== MANUAL_DESC) {
        console.error("❌ Step 2 Failed!");
        return;
    }

    // 3. Restore
    console.log("\n🔹 Step 3: Restoring Manual Description");
    npcRepository.restoreManualNpcDescription(campaignId, TEST_NPC);

    npc = npcRepository.getNpcEntry(campaignId, TEST_NPC) as any;
    console.log(`[Check] is_manual: ${npc.is_manual} (Expected: 1)`);
    console.log(`[Check] specific description: "${npc.description}" (Expected: Original Manual)`);

    if (npc.is_manual !== 1 || npc.description !== MANUAL_DESC) {
        console.error("❌ Step 3 Failed!");
        return;
    }

    // 4. Unlock (Clear Manual)
    console.log("\n🔹 Step 4: Clearing Manual Description (Unlock)");
    npcRepository.clearManualNpcDescription(campaignId, TEST_NPC);

    npc = npcRepository.getNpcEntry(campaignId, TEST_NPC) as any;
    console.log(`[Check] manual_description: "${npc.manual_description}" (Expected: null)`);

    if (npc.manual_description !== null) {
        console.error("❌ Step 4 Failed!");
        return;
    }

    console.log("\n✅ ALL TESTS PASSED!");
}

runTest().catch(console.error);
