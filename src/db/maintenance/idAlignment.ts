import { db } from '../client';
import { generateShortId } from '../utils/idGenerator';

/**
 * Ensures all entities (NPCs, Locations, Quests, Monsters, Items, Factions, Artifacts) have a stable Short ID.
 * Generates and saves SIDs for any records missing one.
 */
export function alignEntityShortIds() {
    console.log('[DB] Running Universal Entity ID Alignment...');

    const tables = [
        { name: 'npc_dossier', label: 'NPCs' },
        { name: 'location_atlas', label: 'Atlas' },
        { name: 'quests', label: 'Quests' },
        { name: 'bestiary', label: 'Bestiary' },
        { name: 'inventory', label: 'Inventory' },
        { name: 'location_history', label: 'Travel Log' },
        { name: 'world_history', label: 'Timeline' },
        { name: 'factions', label: 'Factions' },
        { name: 'artifacts', label: 'Artifacts' }
    ];

    // Verify table existence
    const missingTables: string[] = [];
    const existingTables: string[] = [];

    for (const table of tables) {
        const exists = db.prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
        ).get(table.name);

        if (exists) {
            existingTables.push(table.label);
        } else {
            missingTables.push(table.label);
        }
    }

    if (missingTables.length > 0) {
        console.log(`[DB] ⚠️ Missing tables: ${missingTables.join(', ')}`);
    }

    console.log(`[DB] ✅ Tables verified: ${existingTables.join(', ')}`);

    db.transaction(() => {
        for (const table of tables) {
            // Skip if table doesn't exist
            const exists = db.prepare(
                `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
            ).get(table.name);
            if (!exists) continue;

            const records = db.prepare(`SELECT id FROM ${table.name} WHERE short_id IS NULL`).all() as { id: number }[];

            if (records.length > 0) {
                console.log(`[DB] 🔹 Backfilling Short IDs for ${records.length} ${table.label}...`);

                const updateStmt = db.prepare(`UPDATE ${table.name} SET short_id = ? WHERE id = ?`);
                for (const record of records) {
                    const sid = generateShortId(table.name);
                    updateStmt.run(sid, record.id);
                }
            }
        }
    })();

    console.log('[DB] Entity ID Alignment complete.');
}

