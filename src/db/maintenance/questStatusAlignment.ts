import { db } from '../client';
import { QuestStatus } from '../types';

/**
 * Aligns quest statuses in the database to canonical values defined in QuestStatus enum.
 * Handles legacy strings like 'IN CORSO' or variations from different AI versions.
 */
export function alignQuestStatuses() {
    console.log('[DB] Running Quest Status Alignment...');

    const alignmentMap: Record<string, QuestStatus> = {
        // In Progress variations
        'IN CORSO': QuestStatus.IN_PROGRESS,
        'IN_PROGRESS': QuestStatus.IN_PROGRESS,
        'PROGRESS': QuestStatus.IN_PROGRESS,
        'IN PROGRESS': QuestStatus.IN_PROGRESS,

        // Completed variations
        'COMPLETED': QuestStatus.COMPLETED,
        'DONE': QuestStatus.COMPLETED,
        'COMPLETATA': QuestStatus.COMPLETED,
        'SUCCEEDED': QuestStatus.COMPLETED,
        'FINISH': QuestStatus.COMPLETED,
        'FINISHED': QuestStatus.COMPLETED,

        // Failed variations
        'FAILED': QuestStatus.FAILED,
        'FALLITA': QuestStatus.FAILED,
        'FAIL': QuestStatus.FAILED,

        // Open variations
        'OPEN': QuestStatus.OPEN,
        'APERTA': QuestStatus.OPEN,
        'DA INIZIARE': QuestStatus.OPEN,
        'TODO': QuestStatus.OPEN
    };

    let totalUpdated = 0;

    db.transaction(() => {
        const quests = db.prepare('SELECT id, status FROM quests').all() as { id: number, status: string }[];

        for (const quest of quests) {
            const currentStatus = quest.status?.toUpperCase() || 'OPEN';
            const canonicalStatus = alignmentMap[currentStatus];

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
