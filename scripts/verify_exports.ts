
import { listAllAtlasEntries, getAllNpcs } from '../src/db';
import { resetAllCharacterBios } from '../src/bard/sync/character';
import { syncNpcDossierIfNeeded } from '../src/bard/sync/npc';
import { syncAtlasEntryIfNeeded } from '../src/bard/sync/atlas';

async function check() {
    console.log("Checking exports...");

    if (typeof listAllAtlasEntries !== 'function') {
        console.error("❌ Missing listAllAtlasEntries");
        process.exit(1);
    } else {
        console.log("✅ listAllAtlasEntries found");
    }

    if (typeof getAllNpcs !== 'function') {
        console.error("❌ Missing getAllNpcs");
        process.exit(1);
    } else {
        console.log("✅ getAllNpcs found");
    }

    console.log("All critical exports verified.");
}

check().catch(console.error);
