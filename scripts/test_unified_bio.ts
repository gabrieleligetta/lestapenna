
import { db, addAtlasEvent, getAtlasHistory } from '../src/db';
import { generateBio } from '../src/bard/bio';

async function testUnifiedFlow() {
    console.log("🧪 Testing Unified Bio Flow...");

    // 0. Ensure Campaign Exists
    let row = db.prepare("SELECT id FROM campaigns LIMIT 1").get() as { id: number } | undefined;
    let campId = row ? row.id : 0;

    if (!campId) {
        console.log("⚠️ No campaign found. Creating dummy campaign for testing...");
        const res = db.prepare("INSERT INTO campaigns (name, guild_id, created_at) VALUES ('TestCamp', 'test-guild', 0)").run();
        campId = Number(res.lastInsertRowid);
    }

    console.log(`ℹ️ Using Campaign ID: ${campId}`);

    // 1. Setup Test Data for Atlas
    const macro = "TestRegion";
    const micro = "TestCity";

    // Cleanup
    db.prepare('DELETE FROM location_atlas WHERE campaign_id = ? AND macro_location = ?').run(campId, macro);
    db.prepare('DELETE FROM atlas_history WHERE campaign_id = ? AND macro_location = ?').run(campId, macro);

    console.log("📝 Adding events to Atlas History...");

    addAtlasEvent(campId, macro, micro, null, "The city has high walls made of obsidian.", "OBSERVATION");
    addAtlasEvent(campId, macro, micro, null, "A dragon attacked the northern gate.", "EVENT");
    addAtlasEvent(campId, macro, micro, null, "It smells of sulfur and ash.", "MANUAL_UPDATE");

    const history = getAtlasHistory(campId, macro, micro);
    console.log(`✅ Retrieved ${history.length} events from history.`);

    // 2. Test Generator
    console.log("🧬 Generating Bio...");

    const bio = await generateBio('LOCATION', {
        name: `${macro} - ${micro}`,
        macro: macro,
        micro: micro,
        currentDesc: ""
    }, history);

    console.log("\n✨ Generated Bio:\n", bio);

    if (bio.includes("obsidian") && (bio.includes("dragon") || bio.includes("drago")) && (bio.includes("sulfur") || bio.includes("zolfo"))) {
        console.log("\n✅ SUCCESS: Bio contains all key elements!");
    } else {
        console.log("\n⚠️ WARNING: Bio might be missing some elements.");
    }
}

testUnifiedFlow().catch(console.error);
