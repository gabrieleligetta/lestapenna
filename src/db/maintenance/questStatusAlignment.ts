import { db } from '../client';
import { normalizeQuestStatus } from '../types';

/**
 * Aligns quest statuses in the database to canonical values defined in QuestStatus enum.
 * Handles legacy strings like 'IN CORSO' or variations from different AI versions.
 */
export function alignQuestStatuses() {
    console.log('[DB] Running Quest Status Alignment...');

    let totalUpdated = 0;

    db.transaction(() => {
        const quests = db.prepare('SELECT id, status FROM quests').all() as { id: number, status: string }[];

        for (const quest of quests) {
            const canonicalStatus = normalizeQuestStatus(quest.status);

            if (canonicalStatus && canonicalStatus !== quest.status) {
                db.prepare('UPDATE quests SET status = ? WHERE id = ?').run(canonicalStatus, quest.id);
                totalUpdated++;
            }
        }
    })();

    if (totalUpdated > 0) {
        console.log(`[DB] ✅ Quest Status Alignment complete. Updated ${totalUpdated} quests.`);
    } else {
        console.log('[DB] Quest Status Alignment complete. No changes needed.');
    }
}
