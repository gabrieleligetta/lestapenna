/**
 * Bard Sync - Quest: sync towards the RAG with bio regeneration.
 * Single card builder + shared batch loop (see entitySync.ts).
 */

import { getQuestByTitle, clearQuestDirtyFlag, getDirtyQuests, getQuestHistory } from '../../db';
import { questRepository } from '../../db/repositories/QuestRepository';
import { ingestEntitySnapshot } from '../rag';
import { generateBio } from '../bio';
import { syncDirtyInBatches, formatHistoryEvents, RAG_PRIORITY_FOOTER } from './entitySync';

function buildQuestRagContent(quest: any, bio: string): string {
    let ragContent = `[[SCHEDA MISSIONE UFFICIALE: ${quest.title}]]\n`;
    ragContent += `TIPO: ${quest.type || 'MAJOR'}\n`;
    ragContent += `STATO: ${quest.status}\n`;
    if (bio) ragContent += `DIARIO COMPLETO: ${bio}\n`;
    return ragContent + RAG_PRIORITY_FOOTER;
}

async function ingestQuest(campaignId: number, quest: any, bio: string): Promise<void> {
    await ingestEntitySnapshot(campaignId, 'QUEST_UPDATE', buildQuestRagContent(quest, bio), [], 'QUEST');
    clearQuestDirtyFlag(campaignId, quest.title);
}

/**
 * Syncs a single quest into the RAG (with bio regeneration).
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

    const history = getQuestHistory(campaignId, questTitle)
        .map((h: any) => ({ description: h.description, event_type: h.event_type }));

    // generateBio already persists the description (see bio.ts, QUEST branch)
    const newBio = await generateBio('QUEST', {
        campaignId,
        name: questTitle,
        role: quest.status,
        currentDesc: quest.description || '',
        manualDescription: (quest as any).manual_description || undefined
    }, history);

    await ingestQuest(campaignId, quest, newBio);
    console.log(`[Sync] Quest ${questTitle} sincronizzata.`);
}

/**
 * Batch sync of every dirty quest.
 */
export async function syncAllDirtyQuests(campaignId: number): Promise<number> {
    const dirty = getDirtyQuests(campaignId);
    if (dirty.length === 0) return 0;

    console.log(`[Sync] 📥 Inizio sync per ${dirty.length} quest...`);

    return syncDirtyInBatches(dirty, 'QUEST',
        (q: any) => ({
            entity: q,
            name: q.title,
            context: {
                name: q.title,
                role: q.status,
                campaignId,
                currentDesc: q.description || '',
                manualDescription: q.manual_description || undefined
            },
            history: formatHistoryEvents(getQuestHistory(campaignId, q.title) as any)
        }),
        async (q: any, newBio: string) => {
            questRepository.updateQuestDescription(campaignId, q.title, newBio);
            await ingestQuest(campaignId, q, newBio);
            console.log(`[Sync] ✅ Quest ${q.title} sincronizzata.`);
        }
    );
}
