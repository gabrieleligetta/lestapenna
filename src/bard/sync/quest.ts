/**
 * Bard Sync - Quest synchronization functions
 */

import { getQuestByTitle, clearQuestDirtyFlag, getDirtyQuests, getQuestHistory } from '../../db';
import { ingestGenericEvent } from '../rag';
import { generateBio } from '../bio';

/**
 * Sincronizza Quest nel RAG (con rigenerazione bio)
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

    // 1. Fetch History and Generate Bio
    const history = getQuestHistory(campaignId, questTitle);
    const simpleHistory = history.map((h: any) => ({ description: h.description, event_type: h.event_type }));

    const newBio = await generateBio('QUEST', {
        campaignId,
        name: questTitle,
        role: quest.status,
        currentDesc: quest.description || ''
    }, simpleHistory);

    // 2. Build RAG content
    let ragContent = `[[SCHEDA MISSIONE UFFICIALE: ${questTitle}]]\n`;
    ragContent += `TIPO: ${quest.type || 'MAJOR'}\n`;
    ragContent += `STATO: ${quest.status}\n`;
    if (newBio) ragContent += `DIARIO COMPLETO: ${newBio}\n`;
    ragContent += `\n(Questa scheda ufficiale ha priorità su informazioni frammentarie precedenti)`;

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
