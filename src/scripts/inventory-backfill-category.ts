/**
 * One-off backfill: guesses a category for existing inventory rows still
 * stuck on the 'OTHER' default (added before addLoot started categorizing
 * items on insert — see src/utils/inventoryCategory.ts). Safe to re-run:
 * only touches rows currently at 'OTHER', and only overwrites them when the
 * heuristic finds a better match.
 *
 * Usage: npx ts-node src/scripts/inventory-backfill-category.ts [campaignId]
 * (omit campaignId to backfill every campaign)
 */
import { db } from '../db/client';
import { guessInventoryCategory } from '../utils/inventoryCategory';

const campaignArg = process.argv[2];
const campaignId = campaignArg ? Number(campaignArg) : undefined;

function run() {
    const rows = (
        campaignId
            ? db.prepare('SELECT id, item_name, description FROM inventory WHERE campaign_id = ? AND category = ?').all(campaignId, 'OTHER')
            : db.prepare('SELECT id, item_name, description FROM inventory WHERE category = ?').all('OTHER')
    ) as Array<{ id: number; item_name: string; description: string | null }>;

    console.log(`Found ${rows.length} inventory item(s) at category 'OTHER'${campaignId ? ` for campaign ${campaignId}` : ''}.`);

    let updated = 0;
    const update = db.prepare('UPDATE inventory SET category = ? WHERE id = ?');
    for (const row of rows) {
        const guess = guessInventoryCategory(row.item_name, row.description);
        if (guess === 'OTHER') continue;
        update.run(guess, row.id);
        updated += 1;
        console.log(`  #${row.id} "${row.item_name}" → ${guess}`);
    }

    console.log(`Done: ${updated}/${rows.length} recategorized.`);
}

run();
