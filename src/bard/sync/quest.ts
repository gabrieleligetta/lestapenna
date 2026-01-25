/**
 * Bard Sync - Quest synchronization functions
 */

import { getQuestByTitle, clearQuestDirtyFlag, getDirtyQuests } from '../../db';
import { ingestGenericEvent } from '../rag';

/**
 * Sincronizza Quest nel RAG
 */
export async function syncQuestEntryIfNeeded(
    campaignId: number,
    questTitle: string,
    force: boolean = false
): Promise<void> {

    const quest = getQuestByTitle(campaignId, questTitle);
    if (!quest) return;

    const needsSync = (quest as any).rag_sync_needed === 1;
    if (!force && !needsSync) return;

    console.log(`[Sync] Avvio sync Quest per ${questTitle}...`);

    let ragContent = `[[MISSIONE/QUEST: ${questTitle}]]\n`;
    ragContent += `STATO: ${quest.status}\n`;
    if (quest.description) ragContent += `DIARIO/NOTE: ${quest.description}\n`;

    await ingestGenericEvent(
        campaignId,
        'QUEST_UPDATE',
        ragContent,
        [],
        'QUEST'
    );

    clearQuestDirtyFlag(campaignId, questTitle);
    console.log(`[Sync] Quest ${questTitle} sincronizzata.`);
}

/**
 * Batch sync di tutte le quest dirty
 */
export async function syncAllDirtyQuests(campaignId: number): Promise<number> {
    const dirty = getDirtyQuests(campaignId);

    if (dirty.length === 0) return 0;

    console.log(`[Sync] Sincronizzazione batch di ${dirty.length} quest...`);

    for (const q of dirty) {
        try {
            await syncQuestEntryIfNeeded(campaignId, q.title, true);
        } catch (e) {
            console.error(`[Sync] Errore sync quest ${q.title}:`, e);
        }
    }

    return dirty.length;
}
