import { db } from '../client';
import { generateShortId } from '../utils/idGenerator';

/**
 * Ensures all entities (NPCs, Locations, Quests, Monsters, Items) have a stable Short ID.
 * Generates and saves SIDs for any records missing one.
 */
export function alignEntityShortIds() {
    console.log('[DB] Running Universal Entity ID Alignment...');

    const tables = [
        { name: 'npc_dossier', label: 'NPCs' },
        { name: 'location_atlas', label: 'Atlas' },
        { name: 'quests', label: 'Quests' },
        { name: 'bestiary', label: 'Bestiary' },
        { name: 'inventory', label: 'Inventory' }
    ];

    db.transaction(() => {
        for (const table of tables) {
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
