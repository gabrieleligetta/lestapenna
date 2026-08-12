
import { campaignRepository } from '../db';
import { rebuildAlignment } from './rebuildAlignment';

const run = async () => {
    // Get active campaign for a guild? Or just first active?
    // Since this is a specialized script, let's just pick the first active one or iterate all.
    // We don't have guild_id here easily.
    // Let's rely on DB queries.

    const { db } = await import('../db/client');
    const campaigns = db.prepare('SELECT id, name FROM campaigns WHERE is_active = 1').all() as { id: number, name: string }[];

    if (campaigns.length === 0) {
        console.log("Nessuna campagna attiva trovata.");
        return;
    }

    for (const campaign of campaigns) {
        console.log(`\n=== Rebuilding Alignment for Campaign: ${campaign.name} (${campaign.id}) ===`);
        const result = await rebuildAlignment.rebuildAll(campaign.id);
        result.forEach(line => console.log(line));
    }

    console.log("\nDone.");
};

run().catch(console.error);
