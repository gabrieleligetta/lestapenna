
import { initDatabase, getSessionAIOutput } from '../src/db/index';

async function main() {
    try {
        console.log("Initializing DB...");
        initDatabase();
        const sessionId = 'test-direct-06901ae2';
        console.log(`Fetching AI output for session: ${sessionId}`);
        const output = getSessionAIOutput(sessionId);

        if (!output) {
            console.log("No output found for this session.");
            return;
        }

        console.log("Analyst Output found:");
        // We are interested in npc_events and npc_dossier_updates specifically for Leosin
        if (output.analystData) {
            console.log(JSON.stringify(output.analystData, null, 2));
        } else {
            console.log("No analystData found.");
        }
    } catch (e) {
        console.error("Error:", e);
    }
}

main();
